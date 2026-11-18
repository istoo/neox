// FILE: PullRequestPipelineSection.tsx
// Purpose: The forge pipeline drill-down on a pull request (GitLab jobs): one row per stage
//          and one per job with its status, elapsed time, and a link to the job's forge page
//          (where its logs live). Mirrors the app's GitLab pane contribution.
// Layer: Pull request presentation
// Exports: PullRequestPipelineSection, PullRequestPipelineContent, usePullRequestPipeline

import type {
  PullRequestPipeline,
  PullRequestPipelineJob,
  PullRequestPipelineStage,
  PullRequestPipelineSummary,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  flattenPipelineJobs,
  formatPipelineDuration,
  mapPipelineStatus,
} from "~/lib/gitlabPipeline.logic";
import { CircleAlertIcon, ExternalLinkIcon, PauseIcon } from "~/lib/icons";
import { pullRequestPipelineQueryOptions } from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { PullRequestDisclosureSection } from "./PullRequestDisclosureSection";
import { PR_FINE_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";
import { useTranslation } from "~/i18n";

export interface PullRequestPipelineState {
  summary: PullRequestPipelineSummary | null;
  pipeline: PullRequestPipeline | null;
  error: string | null;
  isLoading: boolean;
}

/** Loads a PR's pipeline jobs once the PR reports a pipeline, polling while it is live. */
export function usePullRequestPipeline(input: {
  cwd: string | null;
  changeRequestNumber: number;
  summary: PullRequestPipelineSummary | null;
}): PullRequestPipelineState {
  const query = useQuery(
    pullRequestPipelineQueryOptions({
      cwd: input.cwd,
      pipelineId: input.summary?.id ?? null,
      changeRequestNumber: input.summary ? input.changeRequestNumber : null,
      summaryStatus: input.summary?.status ?? null,
      enabled: input.summary !== null,
    }),
  );
  return {
    summary: input.summary,
    pipeline: query.data?.pipeline ?? null,
    error: query.data?.error ?? null,
    isLoading: input.summary !== null && query.isPending,
  };
}

export function PullRequestPipelineSection(props: {
  cwd: string | null;
  changeRequestNumber: number;
  summary: PullRequestPipelineSummary | null;
}) {
  const { t } = useTranslation();
  const state = usePullRequestPipeline(props);
  if (!state.summary) {
    return null;
  }
  const jobCount = state.pipeline ? flattenPipelineJobs(state.pipeline.stages).length : undefined;
  return (
    <PullRequestDisclosureSection
      label={t("git:pipeline")}
      {...(jobCount !== undefined ? { count: jobCount } : {})}
    >
      <PullRequestPipelineContent {...state} />
    </PullRequestDisclosureSection>
  );
}

export function PullRequestPipelineContent(props: PullRequestPipelineState) {
  const { t } = useTranslation();
  if (!props.summary) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <PipelineSummaryRow summary={props.summary} />
      {props.isLoading ? (
        <p className={cn(PR_FINE_TEXT_CLASS_NAME, "text-muted-foreground")}>
          {t("git:pipelineLoadingJobs")}
        </p>
      ) : props.error ? (
        <p className={cn(PR_FINE_TEXT_CLASS_NAME, "text-red-500/80")}>
          {t("git:pipelineJobsLoadFailed")}
        </p>
      ) : !props.pipeline || props.pipeline.stages.length === 0 ? (
        <p className={cn(PR_FINE_TEXT_CLASS_NAME, "text-muted-foreground")}>
          {t("git:pipelineNoJobs")}
        </p>
      ) : (
        props.pipeline.stages.map((stage) => (
          <PipelineStageGroup key={`${stage.name}:${stage.jobs[0]?.id ?? "empty"}`} stage={stage} />
        ))
      )}
    </div>
  );
}

function PipelineSummaryRow({ summary }: { summary: PullRequestPipelineSummary }) {
  const { t } = useTranslation();
  const openPipeline = () => {
    if (summary.url) {
      void ensureNativeApi().shell.openExternal(summary.url);
    }
  };
  return (
    <button
      type="button"
      disabled={!summary.url}
      onClick={openPipeline}
      title={summary.url ? t("git:pipelineOpen") : undefined}
      className={cn(
        PR_META_TEXT_CLASS_NAME,
        "-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left",
        "hover:bg-muted/50 disabled:hover:bg-transparent",
      )}
    >
      <PullRequestCheckStatusIcon status={mapPipelineStatus(summary.status)} />
      <span className="min-w-0 shrink-0 font-medium">
        {t("git:pipelineNumber", { value0: summary.id })}
      </span>
      {summary.status ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary.status}</span>
      ) : (
        <span className="flex-1" />
      )}
      {summary.url ? (
        <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  );
}

function PipelineStageGroup({ stage }: { stage: PullRequestPipelineStage }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1">
        <PullRequestCheckStatusIcon status={mapPipelineStatus(stage.status)} />
        <span className="min-w-0 truncate text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
          {stage.name}
        </span>
      </div>
      {stage.jobs.map((job) => (
        <PipelineJobRow key={job.id} job={job} />
      ))}
    </div>
  );
}

function PipelineJobRow({ job }: { job: PullRequestPipelineJob }) {
  const { t } = useTranslation();
  const duration = formatPipelineDuration(job.durationSeconds);
  const openLogs = () => {
    if (job.url) {
      void ensureNativeApi().shell.openExternal(job.url);
    }
  };
  return (
    <button
      type="button"
      disabled={!job.url}
      onClick={openLogs}
      title={job.url ? t("git:pipelineOpenJobLogs") : undefined}
      className={cn(
        PR_META_TEXT_CLASS_NAME,
        "flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 pl-6 text-left",
        "hover:bg-muted/50 disabled:hover:bg-transparent",
      )}
    >
      <PipelineJobStatusIcon job={job} />
      <span className="min-w-0 flex-1 truncate">{job.name}</span>
      {job.allowFailure ? (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {t("git:pipelineAllowedToFail")}
        </span>
      ) : null}
      {duration ? (
        <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">{duration}</span>
      ) : null}
      {job.url ? (
        <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  );
}

function PipelineJobStatusIcon({ job }: { job: PullRequestPipelineJob }) {
  if (job.status === "manual") {
    return job.allowFailure ? (
      <PauseIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    ) : (
      <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
    );
  }
  const status = mapPipelineStatus(job.status);
  if (job.allowFailure && status === "failure") {
    return <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />;
  }
  return <PullRequestCheckStatusIcon status={status} />;
}
