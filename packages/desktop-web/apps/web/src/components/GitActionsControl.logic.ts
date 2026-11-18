import type {
  GitActionProgressPhase,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@synara/contracts";
import { isTemporaryWorktreeBranch, resolveUniqueSynaraBranchName } from "@synara/shared/git";

import { t } from "~/i18n";
import { NEOLIX_GIT_DRAFT_PR_UI_ENABLED } from "~/neolixFeatures";

export type GitActionIconName = "commit" | "push" | "pr";

export function buildGitActionFailureToast(input: {
  message: string;
  phase: GitActionProgressPhase | null;
  threadId: ThreadId | null;
}) {
  const titles: Record<GitActionProgressPhase, string> = {
    branch: t("git:branchCreationFailed"),
    commit: t("git:commitFailed"),
    push: t("git:pushFailed"),
    pr: t("git:prCreationFailed"),
  };
  return {
    type: "error" as const,
    title: input.phase ? titles[input.phase] : t("git:gitActionFailed"),
    description: input.message,
    timeout: 0,
    data: {
      ...(input.threadId ? { threadId: input.threadId } : {}),
      copyText: input.message,
    },
  };
}

/** Every glyph a git affordance can render — see `gitActionGlyphs.tsx` for the map. */
export type GitGlyphName = GitActionIconName | "sync" | "branch" | "view_pr";

export type GitDialogAction = "commit" | "push" | "commit_push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "commit_push" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint" | "create_branch";
  action?: GitStackedAction;
  hint?: string;
}

const FALLBACK_DEFAULT_BRANCH_NAMES = new Set(["main", "master"]);
const CREATE_PR_UNAVAILABLE_HINT = "git:noBranchChangesToIncludeInAPR";

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export function requiresFeatureBranchForDefaultBranchAction(
  action: DefaultBranchConfirmableAction,
): boolean {
  return action === "create_pr" || action === "commit_push_pr";
}

const SHORT_SHA_LENGTH = 7;
const TOAST_DESCRIPTION_MAX = 72;

function shortenSha(sha: string | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function truncateText(
  value: string | undefined,
  maxLength = TOAST_DESCRIPTION_MAX,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return "...".slice(0, maxLength);
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function resolveDefaultCreateBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  return resolveUniqueSynaraBranchName(existingBranchNames, preferredBranch);
}

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  forcePushOnly?: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
}): string[] {
  const branchStages = input.featureBranch ? [t("git:preparingFeatureBranch")] : [];
  const pushStage = input.pushTarget
    ? t("git:pushingToTarget", { value0: input.pushTarget })
    : t("git:pushing");
  if (input.action === "push") {
    return [pushStage];
  }
  if (input.action === "create_pr") {
    return input.shouldPushBeforePr ? [pushStage, t("git:creatingPr")] : [t("git:creatingPr")];
  }
  const shouldIncludeCommitStages =
    !input.forcePushOnly && (input.action === "commit" || input.hasWorkingTreeChanges);
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? [t("git:committing")]
      : [t("git:generatingCommitMessage"), t("git:committing")];
  if (input.action === "commit") {
    return [...branchStages, ...commitStages];
  }
  if (input.action === "commit_push") {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, t("git:creatingPr")];
}

const withDescription = (title: string, description: string | undefined) =>
  description ? { title, description } : { title };

export type CreatePrExecution =
  | { kind: "run_action"; action: "create_pr" | "commit_push_pr" }
  | { kind: "open_pr" }
  | { kind: "unavailable"; hint: string };

/**
 * Create PR is a "do everything" action: it resolves whichever stacked action
 * completes the missing steps (commit → push/publish → PR) from the current git
 * state. Behind/diverged branches stay blocked so a one-click action never has
 * to auto-resolve merge conflicts; the default branch keeps its confirmation
 * dialog (handled by the caller) before switching to a feature branch.
 */
export function resolveCreatePrExecution(input: {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  isDefaultBranch: boolean;
  hasOriginRemote: boolean;
  defaultBranchName?: string | null | undefined;
  /** False when Neox cannot create the feature branch a PR from the default branch needs. */
  allowFeatureBranch?: boolean | undefined;
}): CreatePrExecution {
  const { gitStatus, isBusy, isDefaultBranch, hasOriginRemote, defaultBranchName } = input;
  if (isBusy) return { kind: "unavailable", hint: t("git:pullAndPushBusy") };
  if (!gitStatus) return { kind: "unavailable", hint: t("git:pullAndPushStatusUnavailable") };
  if (gitStatus.pr?.state === "open") return { kind: "open_pr" };
  if (gitStatus.branch === null) {
    return { kind: "unavailable", hint: t("git:detachedHeadCreatePr") };
  }
  // A PR needs a head branch that differs from the base. Neox cannot create one in
  // place, so point at the branch step instead of failing after the commit.
  if (isDefaultBranch && input.allowFeatureBranch === false) {
    return { kind: "unavailable", hint: t("git:createBranchBeforePushPr") };
  }

  const isAhead = gitStatus.aheadCount > 0;
  if (gitStatus.behindCount > 0) {
    return {
      kind: "unavailable",
      hint: isAhead ? t("git:branchDivergedRebaseFirst") : t("git:branchBehindPullBeforePr"),
    };
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return { kind: "unavailable", hint: t("git:addOriginRemoteBeforePr") };
  }

  if (gitStatus.hasWorkingTreeChanges) {
    return { kind: "run_action", action: "commit_push_pr" };
  }

  const canCreateCleanPublishedPr =
    !isDefaultBranch &&
    gitStatus.hasUpstream &&
    gitStatus.upstreamBranch !== null &&
    !tracksDefaultUpstream(gitStatus, defaultBranchName);
  if (isAhead || canCreateCleanPublishedPr) {
    return { kind: "run_action", action: "create_pr" };
  }

  return { kind: "unavailable", hint: t(CREATE_PR_UNAVAILABLE_HINT) };
}

function extractTrackedBranchName(upstreamBranch: string | null | undefined): string | null {
  if (!upstreamBranch) return null;
  const branchName = upstreamBranch.trim();
  return branchName.length > 0 ? branchName : null;
}

export function resolveCreatePrBaseBranch(
  gitStatus: GitStatusResult | null,
  defaultBranchName?: string | null,
): string {
  if (gitStatus?.configuredPrBaseBranch) {
    return gitStatus.configuredPrBaseBranch;
  }
  const trackedBranchName = extractTrackedBranchName(gitStatus?.upstreamBranch);
  if (gitStatus?.hasUpstream && trackedBranchName && trackedBranchName !== gitStatus.branch) {
    return trackedBranchName;
  }
  return defaultBranchName ?? "main";
}

function tracksDefaultUpstream(
  gitStatus: GitStatusResult,
  defaultBranchName?: string | null,
): boolean {
  const trackedBranchName = extractTrackedBranchName(gitStatus.upstreamBranch);
  if (!trackedBranchName) return false;
  if (defaultBranchName) return trackedBranchName === defaultBranchName;
  return FALLBACK_DEFAULT_BRANCH_NAMES.has(trackedBranchName);
}

/** Git state a dialog resolves its available actions from — shared by Create PR and Commit. */
export interface GitDialogContext {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  isDefaultBranch: boolean;
  hasOriginRemote: boolean;
  defaultBranchName?: string | null | undefined;
  /** False hides actions that need an in-place feature branch Neox cannot create. */
  allowFeatureBranch?: boolean | undefined;
}

export interface CreatePrDialogRuntimeStatus {
  gitStatus: GitStatusResult | null;
  isDefaultBranch: boolean;
  statusOverride: GitStatusResult | null;
}

/**
 * A post-push toast carries a synthetic status so its CTA can open even when
 * the query cache still reflects the pre-push branch. Preserve that exact
 * stale object as a freshness marker: the synthetic snapshot wins while the
 * cache still returns it, then a newly fetched live object takes over so later
 * working-tree or branch changes are reflected by the dialog.
 */
export function resolveCreatePrDialogRuntimeStatus(input: {
  liveGitStatus: GitStatusResult | null;
  statusOverride: GitStatusResult | null;
  statusOverrideSource: GitStatusResult | null;
  isDefaultBranch: boolean;
  isDefaultBranchOverride: boolean | null;
}): CreatePrDialogRuntimeStatus {
  const liveStatusIsKnownStale =
    input.liveGitStatus !== null && input.liveGitStatus === input.statusOverrideSource;
  if (input.liveGitStatus && !liveStatusIsKnownStale) {
    return {
      gitStatus: input.liveGitStatus,
      isDefaultBranch: input.isDefaultBranch,
      statusOverride: null,
    };
  }
  return {
    gitStatus: input.statusOverride,
    isDefaultBranch: input.isDefaultBranchOverride ?? input.isDefaultBranch,
    statusOverride: input.statusOverride,
  };
}

/**
 * Execution for the Create PR dialog, honoring the "Commit and push local
 * changes" toggle: with the toggle off a dirty tree is evaluated as if it were
 * clean, so the dialog can offer a PR from already-committed work only (and
 * correctly reports unavailability when nothing is committed).
 */
export function resolveCreatePrDialogExecution(
  context: GitDialogContext,
  includeLocalChanges: boolean,
): CreatePrExecution {
  const { gitStatus } = context;
  if (!gitStatus || includeLocalChanges || !gitStatus.hasWorkingTreeChanges) {
    return resolveCreatePrExecution(context);
  }
  return resolveCreatePrExecution({
    ...context,
    gitStatus: { ...gitStatus, hasWorkingTreeChanges: false },
  });
}

export interface CreatePrDialogView {
  branchName: string | null;
  baseBranchName: string;
  // The PR head does not exist on the remote yet: either the current branch is
  // unpublished or a feature branch will be created off the default branch.
  isNewBranch: boolean;
  // Submitting creates an auto-named feature branch first (default-branch flow).
  willCreateFeatureBranch: boolean;
  showCommitToggle: boolean;
  // The daemon rejects draft PR creation, so the dialog only offers it when the
  // backend feature flag says a draft route exists.
  showDraftAction: boolean;
  insertions: number;
  deletions: number;
}

export function resolveCreatePrDialogView(context: GitDialogContext): CreatePrDialogView {
  const gitStatus = context.gitStatus;
  return {
    branchName: gitStatus?.branch ?? null,
    baseBranchName: resolveCreatePrBaseBranch(gitStatus, context.defaultBranchName),
    isNewBranch: context.isDefaultBranch || gitStatus?.hasUpstream !== true,
    willCreateFeatureBranch: context.isDefaultBranch,
    showCommitToggle: gitStatus?.hasWorkingTreeChanges === true,
    showDraftAction: NEOLIX_GIT_DRAFT_PR_UI_ENABLED,
    insertions: gitStatus?.workingTree.insertions ?? 0,
    deletions: gitStatus?.workingTree.deletions ?? 0,
  };
}

export type CreatePrBrowserPreparation =
  | { kind: "run_action"; action: "commit_push" | "push" }
  | { kind: "open_compare" }
  | { kind: "open_pr" }
  | { kind: "unavailable"; hint: string };

/**
 * "Open PR in browser" runs only the missing local steps (commit and/or push)
 * and then opens the GitHub compare page, leaving PR authoring to the browser.
 */
export function resolveCreatePrBrowserPreparation(
  context: GitDialogContext,
  includeLocalChanges: boolean,
): CreatePrBrowserPreparation {
  const execution = resolveCreatePrDialogExecution(context, includeLocalChanges);
  if (execution.kind !== "run_action") return execution;
  if (execution.action === "commit_push_pr") {
    return { kind: "run_action", action: "commit_push" };
  }
  const gitStatus = context.gitStatus;
  if (!gitStatus?.hasUpstream || gitStatus.aheadCount > 0) {
    return { kind: "run_action", action: "push" };
  }
  return { kind: "open_compare" };
}

export function summarizeGitResult(result: GitRunStackedActionResult): {
  title: string;
  description?: string;
} {
  if (result.pr.status === "created" || result.pr.status === "opened_existing") {
    const prNumber = result.pr.number ? ` #${result.pr.number}` : "";
    const title = `${t(result.pr.status === "created" ? "git:createdPr" : "git:openedPr")}${prNumber}`;
    return withDescription(title, truncateText(result.pr.title));
  }

  if (result.push.status === "pushed") {
    const shortSha = shortenSha(result.commit.commitSha);
    const branch = result.push.upstreamBranch ?? result.push.branch;
    const title =
      shortSha && branch
        ? t("git:pushedShaToBranch", { sha: shortSha, branch })
        : shortSha
          ? t("git:pushedSha", { sha: shortSha })
          : branch
            ? t("git:pushedToBranch", { branch })
            : t("git:pushed");
    return withDescription(title, truncateText(result.commit.subject));
  }

  if (result.commit.status === "created") {
    const shortSha = shortenSha(result.commit.commitSha);
    const title = shortSha ? t("git:committedSha", { sha: shortSha }) : t("git:committedChanges");
    return withDescription(title, truncateText(result.commit.subject));
  }

  return { title: t("git:detail_done") };
}

export function buildMenuItems(
  gitStatus: GitStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  isDefaultBranch = false,
  defaultBranchName?: string | null,
): GitActionMenuItem[] {
  if (!gitStatus) return [];

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  // A branch without an upstream has never been published, so its commits are
  // "ahead" of nothing: git reports aheadCount 0 until the first push.
  const hasUnpushedCommits = gitStatus.aheadCount > 0 || canPushWithoutUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    hasUnpushedCommits &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCommitPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    (hasChanges || hasUnpushedCommits) &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const prExecution = resolveCreatePrExecution({
    gitStatus,
    isBusy,
    isDefaultBranch,
    hasOriginRemote,
    defaultBranchName,
  });
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: t("git:commit"),
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    ...(hasChanges && !isDefaultBranch
      ? [
          {
            id: "commit_push" as const,
            label: t("git:commitAndPushAction"),
            disabled: !canCommitPush,
            icon: "push" as const,
            kind: "open_dialog" as const,
            dialogAction: "commit_push" as const,
          },
        ]
      : []),
    {
      id: "push",
      label: isDefaultBranch ? t("git:commitAndPushAction") : t("git:push"),
      disabled: !(isDefaultBranch ? canCommitPush : canPush),
      icon: "push",
      kind: "open_dialog",
      dialogAction: isDefaultBranch ? "commit_push" : "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: t("git:createPR"),
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: t("git:createPR"),
          disabled: prExecution.kind !== "run_action",
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

/**
 * Human-readable reason a git menu item is unavailable. Shared by the dropdown picker
 * rows and the Commit dialog action rows so the same blocked action always explains
 * itself with the same sentence.
 */
export function resolveGitMenuActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  defaultBranchName: string | null | undefined;
}): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote, isDefaultBranch, defaultBranchName } = input;
  if (!item.disabled) return null;
  if (isBusy) return t("git:pullAndPushBusy");
  if (!gitStatus) return t("git:pullAndPushStatusUnavailable");

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const action = item.dialogAction ?? item.id;

  if (action === "commit") {
    if (!hasChanges) {
      return t("git:worktreeCleanBeforeCommit");
    }
    return t("git:commitUnavailable");
  }

  if (action === "push") {
    if (!hasBranch) {
      return t("git:detachedHeadBeforePush");
    }
    if (hasChanges) {
      return t("git:commitOrStashBeforePush");
    }
    if (isBehind) {
      return t("git:branchBehindBeforePush");
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return t("git:addOriginRemoteBeforePush");
    }
    // A never-pushed branch has no upstream, so aheadCount stays 0; pushing it
    // publishes the branch. Only a published branch can be "up to date".
    if (gitStatus.hasUpstream && !isAhead) {
      return t("git:noLocalCommitsToPush");
    }
    return t("git:pushUnavailable");
  }

  if (action === "commit_push") {
    if (!hasBranch) {
      return t("git:detachedHeadBeforeCommitPush");
    }
    if (isBehind) {
      return t("git:branchBehindBeforeCommitPush");
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return t("git:addOriginRemoteBeforeCommitPush");
    }
    if (!hasChanges && !isAhead && gitStatus.hasUpstream) {
      return t("git:noLocalChangesOrCommits");
    }
    return t("git:commitPushUnavailable");
  }

  if (hasOpenPr) {
    return t("git:viewPrUnavailable");
  }
  const prExecution = resolveCreatePrExecution({
    gitStatus,
    isBusy,
    isDefaultBranch,
    hasOriginRemote,
    defaultBranchName,
  });
  if (prExecution.kind === "unavailable") {
    return prExecution.hint;
  }
  return t("git:createPrCurrentlyUnavailable");
}

export type GitCommitDialogActionId = "commit_new_branch" | "commit" | "commit_push" | "create_pr";

export interface GitCommitDialogAction {
  id: GitCommitDialogActionId;
  label: string;
  icon: GitGlyphName;
  /** Stacked action to dispatch; `create_pr` hands off to the Create PR dialog. */
  action: "commit" | "push" | "commit_push" | "create_pr";
  /** Commit onto a freshly created feature branch instead of the current one. */
  featureBranch: boolean;
  disabled: boolean;
  disabledReason: string | null;
}

const NO_FILE_SELECTION_HINT = "git:selectAtLeastOneFile";

/**
 * Action rows offered by the Commit dialog. Commit-family rows reuse the dropdown
 * menu's availability and wording (so "Commit & push" collapses to "Push" on a clean
 * tree exactly as the menu does), while the PR row mirrors the one-click Create PR
 * resolution and only ever hands off to the Create PR dialog.
 */
export function resolveCommitDialogActions(input: {
  context: GitDialogContext;
  /** False when the user excluded every changed file in the dialog's file list. */
  hasFileSelection: boolean;
}): GitCommitDialogAction[] {
  const { gitStatus, isBusy, isDefaultBranch, hasOriginRemote, defaultBranchName } = input.context;
  const menuItems = buildMenuItems(
    gitStatus,
    isBusy,
    hasOriginRemote,
    isDefaultBranch,
    defaultBranchName,
  );
  const commitItem = menuItems.find((item) => item.id === "commit") ?? null;
  const pushItem =
    menuItems.find((item) => item.id === "commit_push") ??
    menuItems.find((item) => item.id === "push") ??
    null;
  const reasonInput = {
    gitStatus,
    isBusy,
    hasOriginRemote,
    isDefaultBranch,
    defaultBranchName,
  };

  const resolveRowState = (item: GitActionMenuItem | null, gateOnSelection: boolean) => {
    if (!item) {
      return {
        disabled: true,
        disabledReason: isBusy ? t("git:pullAndPushBusy") : t("git:pullAndPushStatusUnavailable"),
      };
    }
    if (item.disabled) {
      return {
        disabled: true,
        disabledReason: resolveGitMenuActionDisabledReason({ item, ...reasonInput }),
      };
    }
    if (gateOnSelection && !input.hasFileSelection) {
      return { disabled: true, disabledReason: t(NO_FILE_SELECTION_HINT) };
    }
    return { disabled: false, disabledReason: null };
  };

  const prExecution = resolveCreatePrExecution({
    gitStatus,
    isBusy,
    isDefaultBranch,
    hasOriginRemote,
    defaultBranchName,
    ...(input.context.allowFeatureBranch !== undefined
      ? { allowFeatureBranch: input.context.allowFeatureBranch }
      : {}),
  });
  // A pure push needs no working-tree selection; anything that commits does.
  const pushCommits = pushItem?.dialogAction !== "push";

  return [
    ...(input.context.allowFeatureBranch === false
      ? []
      : [
          {
            id: "commit_new_branch" as const,
            label: t("git:commitOnNewBranch"),
            icon: "branch" as const,
            action: "commit" as const,
            featureBranch: true,
            ...resolveRowState(commitItem, true),
          },
        ]),
    {
      id: "commit",
      label: t("git:commit"),
      icon: "commit",
      action: "commit",
      featureBranch: false,
      ...resolveRowState(commitItem, true),
    },
    {
      id: "commit_push",
      label: pushItem?.label ?? t("git:commitAndPushAction"),
      icon: "push",
      action: pushItem?.dialogAction === "push" ? "push" : "commit_push",
      featureBranch: false,
      ...resolveRowState(pushItem, pushCommits),
    },
    {
      id: "create_pr",
      label: prExecution.kind === "open_pr" ? t("git:viewPR") : t("git:createPR"),
      icon: prExecution.kind === "open_pr" ? "view_pr" : "pr",
      action: "create_pr",
      featureBranch: false,
      disabled: prExecution.kind === "unavailable",
      disabledReason: prExecution.kind === "unavailable" ? prExecution.hint : null,
    },
  ];
}

export function resolveQuickAction(
  gitStatus: GitStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
  shouldOfferCreateBranch = false,
  _defaultBranchName?: string | null,
): GitQuickAction {
  if (isBusy) {
    return {
      label: t("git:commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("git:pullAndPushBusy"),
    };
  }

  if (!gitStatus) {
    return {
      label: t("git:commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("git:pullAndPushStatusUnavailable"),
    };
  }

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;

  if (!hasBranch) {
    if (shouldOfferCreateBranch) {
      return {
        label: t("git:createBranch"),
        disabled: false,
        kind: "create_branch",
      };
    }
    return {
      label: t("git:commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("git:createBranchBeforePushPr"),
    };
  }

  if (!gitStatus.hasUpstream && shouldOfferCreateBranch) {
    return {
      label: t("git:createBranch"),
      disabled: false,
      kind: "create_branch",
    };
  }

  if (gitStatus.hasUpstream) {
    if (isDiverged) {
      return {
        label: t("git:syncBranch"),
        disabled: true,
        kind: "show_hint",
        hint: t("git:branchDivergedRebaseFirst"),
      };
    }

    if (isBehind) {
      return {
        label: t("git:pull"),
        disabled: false,
        kind: "run_pull",
      };
    }
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return {
        label: t("git:commit"),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("git:commitAndPushAction"),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: t("git:commitPushAndPr"),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: t("git:viewPR"), disabled: false, kind: "open_pr" };
      }
      return {
        label: t("git:push"),
        disabled: true,
        kind: "show_hint",
        hint: t("git:addOriginRemoteBeforePushOrPr"),
      };
    }
    if (hasOpenPr && !isAhead) {
      return { label: t("git:viewPR"), disabled: false, kind: "open_pr" };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: isDefaultBranch ? t("git:commitAndPushAction") : t("git:push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: t("git:pushAndCreatePr"),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: isDefaultBranch ? t("git:commitAndPushAction") : t("git:push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: t("git:pushAndCreatePr"),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: t("git:viewPR"), disabled: false, kind: "open_pr" };
  }

  return {
    label: t("git:commit"),
    disabled: true,
    kind: "show_hint",
    hint: t("git:branchUpToDateNoAction"),
  };
}

/**
 * Availability of the literal `create_pr` stacked action (clean tree required).
 * Guards stale dispatches from surfaces that resolved their action earlier
 * (quick action, post-push toast CTA); the menu path resolves the full chain
 * via resolveCreatePrExecution instead.
 */
export function resolveCreatePrActionAvailability(input: {
  gitStatus: GitStatusResult | null;
  isDefaultBranch?: boolean;
  hasOriginRemote?: boolean;
  defaultBranchName?: string | null | undefined;
}): { canRun: boolean; hint: string | null } {
  const execution = resolveCreatePrExecution({
    gitStatus: input.gitStatus,
    isBusy: false,
    isDefaultBranch: input.isDefaultBranch ?? false,
    hasOriginRemote: input.hasOriginRemote ?? true,
    defaultBranchName: input.defaultBranchName,
  });
  const canRun = execution.kind === "run_action" && execution.action === "create_pr";
  const hint = (() => {
    if (canRun) return null;
    if (execution.kind === "unavailable") return execution.hint;
    if (execution.kind === "open_pr") {
      return t("git:prAlreadyOpenForBranch");
    }
    if (execution.kind === "run_action" && execution.action === "commit_push_pr") {
      return t("git:commitChangesBeforePr");
    }
    return t(CREATE_PR_UNAVAILABLE_HINT);
  })();

  return {
    canRun,
    hint,
  };
}

export function resolvePullActionAvailability(input: {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
}): { canRun: boolean; hint: string | null } {
  const { gitStatus, isBusy } = input;
  if (isBusy) return { canRun: false, hint: t("git:pullAndPushBusy") };
  if (!gitStatus) return { canRun: false, hint: t("git:pullAndPushStatusUnavailable") };
  if (gitStatus.branch === null) {
    return { canRun: false, hint: t("git:detachedHeadBeforePull") };
  }
  if (!gitStatus.hasUpstream) {
    return { canRun: false, hint: t("git:pullAndPushNoUpstream") };
  }
  if (gitStatus.aheadCount > 0 && gitStatus.behindCount > 0) {
    return { canRun: false, hint: t("git:branchDivergedRebaseFirst") };
  }
  // `behindCount` comes from the last fetch, so "0 behind" does not prove the
  // remote is unchanged. Let the pull run and fetch; it is a no-op when current.
  return { canRun: true, hint: null };
}

/** Why "Pull and push" is unavailable; the caller maps each code to a localized hint. */
export type PullAndPushDisabledReason =
  | "busy"
  | "status_unavailable"
  | "detached_head"
  | "no_remote"
  | "no_upstream"
  | "dirty_worktree"
  | "already_in_sync"
  | "diverged";

/**
 * The combined action runs a pull and then a push, so it needs a clean branch with an
 * upstream that is not diverged. One-sided branches are allowed: the half with nothing
 * to do is a no-op, and either way the user gets a single sync action.
 */
export function resolvePullAndPushAvailability(input: {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): { canRun: boolean; reason: PullAndPushDisabledReason | null } {
  const { gitStatus, isBusy, hasOriginRemote } = input;
  if (isBusy) return { canRun: false, reason: "busy" };
  if (!gitStatus) return { canRun: false, reason: "status_unavailable" };
  if (gitStatus.branch === null) return { canRun: false, reason: "detached_head" };
  if (!hasOriginRemote) return { canRun: false, reason: "no_remote" };
  if (!gitStatus.hasUpstream) return { canRun: false, reason: "no_upstream" };
  if (gitStatus.hasWorkingTreeChanges) return { canRun: false, reason: "dirty_worktree" };
  // A cached ahead/behind count of 0 does not mean the remote has not moved;
  // the pull phase fetches first and is a no-op when the branch is current.
  if (gitStatus.aheadCount > 0 && gitStatus.behindCount > 0) {
    return { canRun: false, reason: "diverged" };
  }
  return { canRun: true, reason: null };
}

/** Promote Pull as the primary git affordance while it is available or already running. */
export function shouldPromotePullAction(input: {
  quickAction: GitQuickAction;
  isPullRunning: boolean;
}): boolean {
  return (
    input.isPullRunning || (input.quickAction.kind === "run_pull" && !input.quickAction.disabled)
  );
}

export interface PromotedPullPresentation {
  label: string;
}

/**
 * Chrome for a promoted Pull control. `resolveQuickAction` collapses to a disabled
 * "Commit" hint while any git action is running, so callers must not use that label
 * while Pull is the promoted affordance.
 */
export function resolvePromotedPullPresentation(input: {
  quickAction: GitQuickAction;
  isPullRunning: boolean;
}): PromotedPullPresentation | null {
  if (!shouldPromotePullAction(input)) return null;
  return { label: input.isPullRunning ? t("git:pulling") : t("git:pull") };
}

export function shouldOfferCreateBranchPrompt(input: {
  activeWorktreePath: string | null;
  gitStatus: Pick<GitStatusResult, "branch" | "hasUpstream"> | null;
  createBranchFlowCompleted?: boolean;
}): boolean {
  if (!input.activeWorktreePath) return false;
  if (!input.gitStatus) return false;
  if (input.gitStatus.hasUpstream) return false;
  if (input.createBranchFlowCompleted) return false;
  return true;
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): action is DefaultBranchConfirmableAction {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: t("git:commitPushToDefaultBranchTitle"),
        description: t("git:commitPushOnBranchDescription", { branch: branchLabel }),
        continueLabel: t("git:commitPushToBranch", { branch: branchLabel }),
      };
    }
    return {
      title: t("git:pushToDefaultBranchTitle"),
      description: t("git:pushOnBranchDescription", { branch: branchLabel }),
      continueLabel: t("git:pushToBranch", { branch: branchLabel }),
    };
  }

  if (input.includesCommit) {
    return {
      title: t("git:createFeatureBranchCommitPrTitle"),
      description: t("git:cannotOpenPrFromBranchWithCommit", { branch: branchLabel }),
      continueLabel: t("git:createFeatureBranchContinue"),
    };
  }
  return {
    title: t("git:createFeatureBranchPrTitle"),
    description: t("git:cannotOpenPrFromBranch", { branch: branchLabel }),
    continueLabel: t("git:createFeatureBranchContinue"),
  };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: GitStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  // Branch list not ready yet — don't treat "status arrived first" as out-of-sync
  // or we permanently invalidate and show "Refreshing git status...".
  if (input.threadBranch === null) {
    return null;
  }

  if (input.gitStatus.branch === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.branch) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.branch !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.branch)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.branch,
  };
}

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@synara/shared/git";
