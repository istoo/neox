import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { GitPullRequestMergeability } from "./git";

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals(["merge", "ready", "draft", "close", "reopen"]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestCommitAuthor = Schema.Struct({
  login: Schema.NullOr(TrimmedNonEmptyString),
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type PullRequestCommitAuthor = typeof PullRequestCommitAuthor.Type;

export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

export const PullRequestCheckStatus = Schema.Literals([
  "pending",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  /** Forge-formatted elapsed time, e.g. "2m" while running or "1m 4s" once finished. */
  duration: Schema.optional(Schema.String),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

/**
 * One CI job in a pipeline. Status strings stay open (`success`, `failed`, `running`,
 * `manual`, …) because each forge reports its own vocabulary; clients map the ones they
 * present and fall back to "pending".
 */
export const PullRequestPipelineJob = Schema.Struct({
  id: PositiveInt,
  name: TrimmedNonEmptyString,
  stage: TrimmedNonEmptyString,
  status: Schema.String,
  url: Schema.NullOr(Schema.String),
  allowFailure: Schema.Boolean,
  durationSeconds: Schema.NullOr(NonNegativeInt),
});
export type PullRequestPipelineJob = typeof PullRequestPipelineJob.Type;

export const PullRequestPipelineStage = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: Schema.String,
  jobs: Schema.Array(PullRequestPipelineJob),
});
export type PullRequestPipelineStage = typeof PullRequestPipelineStage.Type;

export const PullRequestPipeline = Schema.Struct({
  id: PositiveInt,
  status: Schema.String,
  url: Schema.NullOr(Schema.String),
  ref: Schema.NullOr(Schema.String),
  sha: Schema.NullOr(Schema.String),
  stages: Schema.Array(PullRequestPipelineStage),
});
export type PullRequestPipeline = typeof PullRequestPipeline.Type;

/** Forge-side pipeline identity, available even when the job breakdown cannot be fetched. */
export const PullRequestPipelineSummary = Schema.Struct({
  id: PositiveInt,
  status: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type PullRequestPipelineSummary = typeof PullRequestPipelineSummary.Type;

/** `pipelineId` is the forge's check-details id; `changeRequestNumber` resolves forks. */
export const PullRequestPipelineInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  pipelineId: PositiveInt,
  changeRequestNumber: PositiveInt,
});
export type PullRequestPipelineInput = typeof PullRequestPipelineInput.Type;

export const PullRequestPipelineResult = Schema.Struct({
  pipeline: Schema.NullOr(PullRequestPipeline),
  error: Schema.NullOr(Schema.String),
});
export type PullRequestPipelineResult = typeof PullRequestPipelineResult.Type;

export const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
});
export type PullRequestComment = typeof PullRequestComment.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  messageBody: Schema.String,
  committedDate: IsoDateTime,
  authors: Schema.Array(PullRequestCommitAuthor),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
  deleteBranchOnMerge: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestStackEntry = Schema.Struct({
  position: PositiveInt,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: GitPullRequestMergeability,
  mergeStateStatus: Schema.NullOr(Schema.String),
});
export type PullRequestStackEntry = typeof PullRequestStackEntry.Type;

/**
 * GitHub orders stack entries from the ultimate base branch upwards. `position` is the selected
 * pull request's one-based position, so merging that PR affects entries `1...position` atomically.
 */
export const PullRequestStack = Schema.Struct({
  number: PositiveInt,
  size: PositiveInt,
  position: PositiveInt,
  baseBranch: TrimmedNonEmptyString,
  entries: Schema.Array(PullRequestStackEntry),
});
export type PullRequestStack = typeof PullRequestStack.Type;

/** Compact stack identity used by list rows; full entries stay detail-only. */
export const PullRequestStackSummary = Schema.Struct({
  number: PositiveInt,
  size: PositiveInt,
  position: PositiveInt,
  baseBranch: TrimmedNonEmptyString,
});
export type PullRequestStackSummary = typeof PullRequestStackSummary.Type;

/**
 * How the signed-in `gh` account relates to a pull request or issue. `involved` mirrors GitHub's
 * `involves:` search qualifier (author, assignee, mention, or commenter), so it is true whenever
 * `authored` or `assigned` is, plus mentions and comments the list fields cannot show directly.
 */
export const GitHubViewerInvolvement = Schema.Struct({
  authored: Schema.Boolean,
  assigned: Schema.Boolean,
  involved: Schema.Boolean,
});
export type GitHubViewerInvolvement = typeof GitHubViewerInvolvement.Type;

export const PullRequestProjectContext = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  isPinned: Schema.Boolean,
});
export type PullRequestProjectContext = typeof PullRequestProjectContext.Type;

export const PullRequestListEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  reviewDecision: Schema.NullOr(Schema.String),
  viewerReviewRequested: Schema.Boolean,
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  // A repository-level row can belong to several local projects/worktrees. The fallback keeps a
  // newer client compatible with a server that still sends one project-local row at a time.
  projectContexts: Schema.optional(Schema.Array(PullRequestProjectContext)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  // Decoding default keeps a newer client compatible with an older server that predates
  // the field (brief version skew during dev restarts must not reject whole payloads).
  mergeability: Schema.optional(GitPullRequestMergeability).pipe(
    Schema.withDecodingDefault(() => "unknown"),
  ),
  // Stack support is additive and the server may briefly be on an older build during restarts.
  stack: Schema.optional(Schema.NullOr(PullRequestStackSummary)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  labels: Schema.Array(PullRequestLabel),
  // The inbox query returns these with the row at no extra cost. Decoding defaults keep rows
  // from an older server (or a recovered pin) valid during version skew.
  commentCount: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  assignees: Schema.optional(Schema.Array(PullRequestActor)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  viewerInvolvement: Schema.optional(GitHubViewerInvolvement).pipe(
    Schema.withDecodingDefault(() => ({ authored: false, assigned: false, involved: false })),
  ),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestDetailInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  /** Bypass the server's short detail cache. Query keys deliberately ignore this flag. */
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type PullRequestDetailInput = typeof PullRequestDetailInput.Type;

/** Forge-reported review approvals; GitLab reports these as a given/required pair. */
export const PullRequestApprovals = Schema.Struct({
  given: NonNegativeInt,
  required: PositiveInt,
});
export type PullRequestApprovals = typeof PullRequestApprovals.Type;

export const PullRequestDetail = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.String),
  // Decoding default keeps a newer client compatible with an older server that predates
  // the field (brief version skew during dev restarts must not reject whole payloads).
  mergeability: Schema.optional(GitPullRequestMergeability).pipe(
    Schema.withDecodingDefault(() => "unknown"),
  ),
  mergeStateStatus: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  maintainerCanModify: Schema.Boolean,
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  // Forge pipeline identity from the PR status, so the section can render while jobs load.
  // A missing field is a forge without pipelines or an older server.
  pipeline: Schema.optional(Schema.NullOr(PullRequestPipelineSummary)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  // GitLab's approval rule. Null when the forge has none (GitHub carries reviewDecision instead).
  approvals: Schema.optional(Schema.NullOr(PullRequestApprovals)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  comments: Schema.Array(PullRequestComment),
  commentsTruncated: Schema.Boolean,
  commentsIncomplete: Schema.Boolean,
  commits: Schema.Array(PullRequestCommit),
  mergeCapabilities: PullRequestMergeCapabilities,
  // A missing field is a standalone PR or a brief older-server/newer-client version skew.
  stack: Schema.optional(Schema.NullOr(PullRequestStack)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  // Stack lookup is optional for rendering detail, but merge UX must distinguish an unavailable
  // lookup from a confirmed standalone pull request.
  stackMetadataIncomplete: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  // Forge-reported auto-merge state. Neox keeps the facts on the GitHub status object; a host
  // that does not report them decodes as "not available" instead of failing the whole detail.
  autoMergeEnabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  canEnableAutoMerge: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  canDisableAutoMerge: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestActionInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

/** Enable or disable the forge's auto-merge for the checkout's pull request. */
export const PullRequestSetAutoMergeInput = Schema.Struct({
  ...PullRequestDetailInput.fields,
  enabled: Schema.Boolean,
  /** Required when enabling; ignored when disabling. */
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type PullRequestSetAutoMergeInput = typeof PullRequestSetAutoMergeInput.Type;

export const PullRequestCommentInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  // GitHub rejects comment bodies past 65536 characters; enforcing it here keeps oversized
  // payloads off the wire and out of subprocess plumbing entirely.
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

export const PullRequestSetPinnedInput = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type PullRequestSetPinnedInput = typeof PullRequestSetPinnedInput.Type;

export const PullRequestSetPinnedResult = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type PullRequestSetPinnedResult = typeof PullRequestSetPinnedResult.Type;

// Actions acknowledge the mutation independently from the follow-up detail refetch. This keeps
// a successful GitHub mutation from being reported as failed when a later read is unavailable.
export const PullRequestActionResult = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  workspaceRoot: TrimmedNonEmptyString,
  // Async merges may finish immediately or be handed to GitHub's merge queue. Older servers and
  // non-merge actions omit the field, which decodes as null for rolling dev restarts.
  mergeOutcome: Schema.optional(Schema.NullOr(Schema.Literals(["merged", "enqueued"]))).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type PullRequestActionResult = typeof PullRequestActionResult.Type;

export class PullRequestsUnavailableError extends Schema.TaggedErrorClass<PullRequestsUnavailableError>()(
  "PullRequestsUnavailableError",
  {
    reason: Schema.Literals(["gh-not-installed", "gh-not-authenticated", "rate-limited"]),
    message: TrimmedNonEmptyString,
    /** When a rate-limited request may be retried. Absent for the gh setup reasons. */
    retryAt: Schema.optional(IsoDateTime),
  },
) {}
