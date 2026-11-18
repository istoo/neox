import type { PullRequestDetailInput, ThreadId } from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";
import { isPipelineActiveStatus } from "./gitlabPipeline.logic";
import {
  GITHUB_ITEM_DETAIL_POLL_INTERVAL_MS,
  GITHUB_ITEM_DETAIL_STALE_TIME_MS,
} from "./githubInboxQueryOptions";

// Pull request lists live in the GitHub inbox query (`githubInboxQueryOptions.ts`); these keys
// cover pull request detail and diff only.
export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  detail: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "detail",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  pipeline: (cwd: string | null, pipelineId: number | null, changeRequestNumber: number | null) =>
    ["pull-requests", "pipeline", cwd, pipelineId, changeRequestNumber] as const,
  diff: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "diff",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  autoFix: (threadId: ThreadId | null) => ["pull-requests", "auto-fix", threadId] as const,
};

/** Distinguish a cold-load failure from a background failure with usable cached data. */
export function pullRequestQueryErrorState<TData, TError>(
  query: { data: TData | undefined; error: TError | null; isError: boolean },
  enabled = true,
): { initialError: TError | null; backgroundError: TError | null } {
  if (!enabled || !query.isError) return { initialError: null, backgroundError: null };
  return query.data === undefined
    ? { initialError: query.error, backgroundError: null }
    : { initialError: null, backgroundError: query.error };
}

export function pullRequestDetailQueryOptions(
  input: PullRequestDetailInput | null,
  behavior: { pollingEnabled?: boolean } = {},
) {
  const pollingEnabled = behavior.pollingEnabled ?? true;
  return queryOptions({
    queryKey: pullRequestQueryKeys.detail(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request detail is unavailable.");
      return ensureNativeApi().pullRequests.detail(input);
    },
    enabled: input !== null,
    staleTime: GITHUB_ITEM_DETAIL_STALE_TIME_MS,
    refetchInterval: pollingEnabled ? GITHUB_ITEM_DETAIL_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: pollingEnabled,
    refetchOnReconnect: pollingEnabled,
  });
}

/**
 * The PR's pipeline drill-down (GitLab jobs). Finished pipelines never change, so polling
 * stops once both the summary and every job have left the active statuses.
 */
export function pullRequestPipelineQueryOptions(input: {
  cwd: string | null;
  pipelineId: number | null;
  changeRequestNumber: number | null;
  /** The PR status's raw pipeline status; drives polling before jobs arrive. */
  summaryStatus: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.pipeline(input.cwd, input.pipelineId, input.changeRequestNumber),
    queryFn: () => {
      if (!input.cwd || input.pipelineId === null || input.changeRequestNumber === null) {
        throw new Error("Pull request pipeline is unavailable.");
      }
      return ensureNativeApi().pullRequests.pipeline({
        cwd: input.cwd,
        pipelineId: input.pipelineId,
        changeRequestNumber: input.changeRequestNumber,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.cwd !== null &&
      input.pipelineId !== null &&
      input.changeRequestNumber !== null,
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (isPipelineActiveStatus(input.summaryStatus)) {
        return 15_000;
      }
      const jobsActive =
        query.state.data?.pipeline?.stages.some((stage) =>
          stage.jobs.some((job) => isPipelineActiveStatus(job.status)),
        ) === true;
      return jobsActive ? 15_000 : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function pullRequestDiffQueryOptions(input: PullRequestDetailInput | null) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.diff(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request diff is unavailable.");
      return ensureNativeApi().pullRequests.diff(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

/** Auto-fix CI state for a thread. The server watcher changes it every minute at most. */
export function pullRequestAutoFixQueryOptions(threadId: ThreadId | null, enabled: boolean) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.autoFix(threadId),
    queryFn: () => {
      if (!threadId) throw new Error("Auto-fix CI is unavailable.");
      return ensureNativeApi().pullRequests.getAutoFix({ threadId });
    },
    enabled: enabled && threadId !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
