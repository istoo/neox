// FILE: gitlabPipeline.logic.ts
// Purpose: Pure presentation helpers for a forge pipeline (GitLab job status vocabulary,
//          active polling window, and elapsed-time formatting). Shared by the pipeline
//          query options and the PR pipeline section.
// Layer: Web domain helpers (no React)

import type { PullRequestCheckStatus, PullRequestPipelineStage } from "@synara/contracts";

/** GitLab reports these while the pipeline is still moving; finished pipelines are immutable. */
const ACTIVE_PIPELINE_STATUSES = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "canceling",
  "scheduled",
]);

export function isPipelineActiveStatus(status: string | null | undefined): boolean {
  return status ? ACTIVE_PIPELINE_STATUSES.has(status) : false;
}

export function mapPipelineStatus(status: string): PullRequestCheckStatus {
  switch (status) {
    case "success":
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      // "manual" and every active transitional status render as pending.
      return "pending";
  }
}

/** App-style compact duration: "12s", "1m 4s", "1h 2m 3s"; null when the job reports none. */
export function formatPipelineDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

export function flattenPipelineJobs(stages: ReadonlyArray<PullRequestPipelineStage>) {
  return stages.flatMap((stage) => stage.jobs);
}
