// Pure Neox → Synara pull-request mapping. Neox exposes one PR status per checkout plus a
// forge-neutral timeline; Synara asks for a git status summary, a resolved reference, and a full
// detail. Keeping the mapping here lets the status handler and the pull-request handlers agree
// on state/mergeability/check translation, and keeps it unit-testable without a client.
import type {
  GitPullRequestCheck,
  GitPullRequestMergeability,
  GitResolvedPullRequest,
  GitStatusResult,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestState,
} from "@synara/contracts";

import { bridgeError } from "./rpcErrors.ts";

export interface NeolixPrCheck {
  readonly name: string;
  readonly status: string;
  readonly url: string | null;
}

export interface NeolixPrGithubFacts {
  readonly mergeStateStatus?: string | null;
  readonly repository?: {
    readonly mergeCommitAllowed?: boolean;
    readonly squashMergeAllowed?: boolean;
    readonly rebaseMergeAllowed?: boolean;
  };
}

export interface NeolixPrStatus {
  readonly forge?: string;
  readonly number?: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly isMerged: boolean;
  readonly isDraft?: boolean;
  readonly mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly checks?: ReadonlyArray<NeolixPrCheck>;
  readonly reviewDecision?: string | null;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly github?: NeolixPrGithubFacts;
}

export interface NeolixPrStatusPayload {
  readonly status: NeolixPrStatus | null;
  readonly error: { readonly message: string } | null;
  readonly githubFeaturesEnabled?: boolean;
  readonly forge?: string;
}

export interface NeolixPrTimelineItem {
  readonly id?: string;
  readonly kind: "review" | "comment";
  readonly author?: string;
  readonly authorUrl?: string | null;
  readonly avatarUrl?: string | null;
  readonly body?: string;
  readonly createdAt?: number;
  readonly url?: string;
  readonly reviewState?: "approved" | "changes_requested" | "commented";
  readonly location?: { readonly path: string };
}

export interface NeolixPrTimeline {
  readonly prNumber?: number | null;
  readonly items?: ReadonlyArray<NeolixPrTimelineItem>;
  readonly truncated?: boolean;
  readonly error?: { readonly message?: string } | null;
}

// oxlint-disable-next-line typescript/no-explicit-any -- branded contract strings
const brand = <T>(value: string): T => value as any as T;

export function pullRequestState(status: NeolixPrStatus): PullRequestState {
  if (status.isMerged || status.state === "merged") return "merged";
  if (status.state !== "open") return "closed";
  return "open";
}

export function mergeabilityOf(status: NeolixPrStatus): GitPullRequestMergeability {
  switch (status.mergeable) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

export function pullRequestNumber(status: NeolixPrStatus): number | null {
  if (typeof status.number === "number" && Number.isFinite(status.number)) {
    return Math.trunc(status.number);
  }
  const match = /\/pull\/(\d+)\b/.exec(status.url);
  return match?.[1] ? Number(match[1]) : null;
}

/** A reference is a URL, `#123`, or `123`; the last number is the pull request. */
export function referenceNumber(reference: string): number | null {
  const matches = reference.match(/\d+/g);
  if (!matches || matches.length === 0) return null;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function pullRequestMatchesReference(status: NeolixPrStatus, reference: string): boolean {
  const wanted = referenceNumber(reference);
  if (wanted === null) return false;
  return pullRequestNumber(status) === wanted;
}

export function toGitStatusPr(status: NeolixPrStatus): NonNullable<GitStatusResult["pr"]> {
  return {
    number: pullRequestNumber(status) ?? 0,
    title: status.title,
    url: status.url,
    baseBranch: status.baseRefName,
    headBranch: status.headRefName,
    state: pullRequestState(status),
    isDraft: status.isDraft === true,
    mergeability: mergeabilityOf(status),
    additions: null,
    deletions: null,
    changedFiles: null,
  };
}

export function toGitResolvedPullRequest(status: NeolixPrStatus): GitResolvedPullRequest {
  return {
    number: pullRequestNumber(status) ?? 0,
    title: status.title,
    url: status.url,
    baseBranch: status.baseRefName,
    headBranch: status.headRefName,
    state: pullRequestState(status),
    isDraft: status.isDraft === true,
    mergeability: mergeabilityOf(status),
    additions: null,
    deletions: null,
    changedFiles: null,
  };
}

/** One `forge.search` change-request hit (the daemon's PR search, as the app's PR picker uses). */
export interface NeolixForgeSearchItem {
  readonly kind: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly baseRefName?: string | null;
  readonly headRefName?: string | null;
}

/**
 * A pull request other than the checkout's, from search. Search carries no draft, mergeability,
 * or diff-size facts, so those read as unknown. Null when the hit lacks its branches.
 */
export function searchItemToResolvedPullRequest(
  item: NeolixForgeSearchItem,
): GitResolvedPullRequest | null {
  const baseBranch = item.baseRefName?.trim();
  const headBranch = item.headRefName?.trim();
  const title = item.title.trim();
  if (!baseBranch || !headBranch || !title || !(item.number > 0)) return null;
  const state = item.state.toLowerCase();
  return {
    number: Math.trunc(item.number),
    title,
    url: item.url,
    baseBranch,
    headBranch,
    state: state === "merged" ? "merged" : state === "open" ? "open" : "closed",
    isDraft: false,
    mergeability: "unknown",
    additions: null,
    deletions: null,
    changedFiles: null,
  };
}

function checkStatus(value: string): PullRequestCheck["status"] {
  if (
    value === "success" ||
    value === "failure" ||
    value === "pending" ||
    value === "skipped" ||
    value === "neutral" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "pending";
}

export function toPullRequestChecks(status: NeolixPrStatus): ReadonlyArray<PullRequestCheck> {
  return (status.checks ?? []).map((check) => ({
    name: check.name,
    status: checkStatus(check.status),
    description: null,
    url: check.url,
    startedAt: null,
    completedAt: null,
  }));
}

export function toGitPullRequestChecks(status: NeolixPrStatus): ReadonlyArray<GitPullRequestCheck> {
  return (status.checks ?? []).map((check) => ({
    name: check.name,
    status: checkStatus(check.status),
    url: check.url,
  }));
}

function isoFromEpochMs(value: number | undefined, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : fallback;
}

export function toPullRequestComments(
  timeline: NeolixPrTimeline,
  fallbackTimestamp: string,
): ReadonlyArray<PullRequestComment> {
  return (timeline.items ?? []).map((item, index) => {
    const kind = item.kind === "review" ? "review" : "issue-comment";
    const author = item.author?.trim();
    const login = author && author.length > 0 ? author : "unknown";
    return {
      id: item.id?.trim() || `${kind}:${index}`,
      kind,
      author: {
        login,
        name: null,
        avatarUrl: item.avatarUrl ?? null,
        url: item.authorUrl ?? null,
      },
      body: item.body ?? "",
      createdAt: isoFromEpochMs(item.createdAt, fallbackTimestamp),
      updatedAt: null,
      url: item.url?.trim() || null,
      path: item.location?.path ?? null,
      reviewState: item.kind === "review" ? (item.reviewState ?? "commented") : null,
    };
  });
}

export interface PullRequestDetailContext {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly now?: string;
}

export function toPullRequestDetail(
  status: NeolixPrStatus,
  timeline: NeolixPrTimeline | null,
  context: PullRequestDetailContext,
): PullRequestDetail {
  const now = context.now ?? new Date().toISOString();
  const number = pullRequestNumber(status);
  if (number === null) {
    throw bridgeError("pr.no-number", "The pull request has no number.");
  }
  const repository =
    status.repoOwner && status.repoName
      ? `${status.repoOwner}/${status.repoName}`
      : context.repository;
  const policy = status.github?.repository;
  return {
    projectId: brand(context.projectId),
    projectTitle: context.projectTitle,
    workspaceRoot: context.workspaceRoot,
    repository,
    number,
    title: status.title,
    body: "",
    url: status.url,
    author: null,
    state: pullRequestState(status),
    isDraft: status.isDraft === true,
    mergeable: status.mergeable ?? null,
    mergeability: mergeabilityOf(status),
    mergeStateStatus: status.github?.mergeStateStatus ?? null,
    reviewDecision: status.reviewDecision ?? null,
    // Neox's PR status carries no diff totals; the code tab reads the checkout diff instead.
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headBranch: status.headRefName,
    baseBranch: status.baseRefName,
    createdAt: now,
    updatedAt: now,
    mergedAt: status.isMerged ? now : null,
    closedAt: pullRequestState(status) === "closed" ? now : null,
    maintainerCanModify: false,
    reviewers: [],
    labels: [],
    checks: toPullRequestChecks(status),
    comments: timeline ? toPullRequestComments(timeline, now) : [],
    commentsTruncated: timeline?.truncated === true,
    commentsIncomplete: timeline?.error != null,
    commits: [],
    mergeCapabilities: {
      merge: policy?.mergeCommitAllowed !== false,
      squash: policy?.squashMergeAllowed !== false,
      rebase: policy?.rebaseMergeAllowed !== false,
      deleteBranchOnMerge: false,
    },
    stack: null,
    stackMetadataIncomplete: false,
  };
}
