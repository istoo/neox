// Pull request surfaces: Synara's detail/diff/action reads and the git snapshot the Environment
// panel polls. Neox answers with one PR per checkout (`checkoutPrStatus`) plus a forge-neutral
// timeline, so detail and actions resolve a reference against the checked-out branch and reject a
// different pull request. Resolving a reference for checkout also searches the forge by number.
import {
  WS_METHODS,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestSnapshotResult,
  type GitResolvedPullRequest,
  type GitResolvePullRequestResult,
  type PullRequestActionResult,
  type PullRequestDetail,
  type PullRequestDetailInput,
  type PullRequestDiffResult,
  type PullRequestMergeMethod,
  type PullRequestPipelineInput,
  type PullRequestPipelineResult,
  type PullRequestSetAutoMergeInput,
} from "@synara/contracts";
import { Effect } from "effect";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { renderUnifiedPatch, type NeolixDiffPayload } from "./gitRpc.ts";
import {
  forgePipelineId,
  formatCheckDurationSeconds,
  pullRequestMatchesReference,
  pullRequestNumber,
  referenceNumber,
  searchItemToResolvedPullRequest,
  toGitPullRequestChecks,
  toGitResolvedPullRequest,
  toPullRequestComments,
  toPullRequestDetail,
  toPullRequestPipeline,
  type NeolixForgeSearchItem,
  type NeolixPrStatus,
  type NeolixPrStatusPayload,
  type NeolixPrTimeline,
} from "./prTranslate.ts";
import { bridgeError, fromPromise } from "./rpcErrors.ts";
import { notSupported, type AnyHandler } from "./stubs.ts";

export async function readPrStatus(
  client: DaemonClient,
  cwd: string,
): Promise<NeolixPrStatus | null> {
  const payload = (await client.checkoutPrStatus(cwd)) as unknown as NeolixPrStatusPayload;
  if (payload.error) {
    throw bridgeError("pr.status-failed", payload.error.message, { detail: payload.error.message });
  }
  return payload.status;
}

async function readTimeline(
  client: DaemonClient,
  cwd: string,
  status: NeolixPrStatus,
): Promise<NeolixPrTimeline | null> {
  const number = pullRequestNumber(status);
  const owner = status.repoOwner?.trim();
  const name = status.repoName?.trim();
  if (number === null || !owner || !name) return null;
  return (await client.pullRequestTimeline({
    cwd,
    prNumber: number,
    repoOwner: owner,
    repoName: name,
  })) as unknown as NeolixPrTimeline;
}

/**
 * GitLab reports check status without timing; the per-job durations live in the forge's
 * check details. The app's PR pane fetches the same route for its pipeline section, so use
 * it here to fill in each check's elapsed time. Any failure leaves the rows without timing
 * rather than failing the whole PR surface.
 */
async function readCheckDurations(
  client: DaemonClient,
  cwd: string,
  status: NeolixPrStatus,
): Promise<ReadonlyMap<number, string> | undefined> {
  const pipelineId = forgePipelineId(status);
  const changeRequestNumber = pullRequestNumber(status);
  if (pipelineId === null || changeRequestNumber === null) {
    return undefined;
  }
  try {
    const payload = await client.checkoutForgeGetCheckDetails({
      cwd,
      checkRunId: pipelineId,
      changeRequestNumber,
    });
    const jobs = payload.details?.pipeline?.stages?.flatMap((stage) => stage.jobs ?? []) ?? [];
    const durations = new Map<number, string>();
    for (const job of jobs) {
      if (
        typeof job.id === "number" &&
        typeof job.durationSeconds === "number" &&
        job.durationSeconds > 0
      ) {
        durations.set(job.id, formatCheckDurationSeconds(job.durationSeconds));
      }
    }
    return durations.size > 0 ? durations : undefined;
  } catch {
    return undefined;
  }
}

function projectContext(
  model: BridgeModel,
  input: PullRequestDetailInput,
): { cwd: string; projectTitle: string; repository: string } {
  const cwd = model.projectRoot(input.projectId)?.trim();
  if (!cwd) {
    throw bridgeError("pr.unknown-project", `Unknown project ${input.projectId}.`, {
      project: input.projectId,
    });
  }
  const project = model
    .shellSnapshot()
    .projects.find((candidate) => candidate.id === input.projectId);
  return {
    cwd,
    projectTitle: project?.title?.trim() || cwd,
    repository: input.repository,
  };
}

async function requireStatus(
  client: DaemonClient,
  cwd: string,
  reference?: string,
): Promise<NeolixPrStatus> {
  const status = await readPrStatus(client, cwd);
  if (!status) {
    throw bridgeError("pr.none-open", "No pull request is open for this checkout.");
  }
  if (pullRequestNumber(status) === null) {
    throw bridgeError("pr.no-number", "The pull request has no number.");
  }
  if (reference && !pullRequestMatchesReference(status, reference)) {
    throw bridgeError(
      "pr.not-this-checkout",
      `Pull request ${reference} is not the checkout's pull request.`,
      { reference },
    );
  }
  return status;
}

/**
 * The pull request a reference names: the checkout's own when it matches (full status), otherwise
 * the daemon's forge search by number — the lookup the app's new-workspace PR picker uses.
 */
async function resolveReference(
  client: DaemonClient,
  cwd: string,
  reference: string,
): Promise<GitResolvedPullRequest> {
  const wanted = referenceNumber(reference);
  if (wanted === null) {
    throw bridgeError("pr.invalid-reference", `"${reference}" does not name a pull request.`, {
      reference,
    });
  }
  const status = await readPrStatus(client, cwd).catch(() => null);
  if (status && pullRequestMatchesReference(status, reference)) {
    return toGitResolvedPullRequest(status);
  }
  const payload = (await client.searchForge({
    cwd,
    query: String(wanted),
    limit: 10,
    kinds: ["change_request"],
  })) as unknown as {
    items?: ReadonlyArray<NeolixForgeSearchItem>;
    error?: { message?: string } | string | null;
  };
  const hit = payload.items?.find(
    (item) => item.kind === "change_request" && item.number === wanted,
  );
  const resolved = hit ? searchItemToResolvedPullRequest(hit) : null;
  if (resolved) return resolved;
  const error = typeof payload.error === "string" ? payload.error : payload.error?.message;
  throw bridgeError("pr.not-found", error?.trim() || `Pull request #${wanted} was not found.`, {
    number: wanted,
    ...(error?.trim() ? { detail: error.trim() } : {}),
  });
}

/** Neox merges by checkout, not by PR number; resolve the reference first. */
async function mergeForReference(
  client: DaemonClient,
  cwd: string,
  reference: string,
  method: PullRequestMergeMethod,
): Promise<void> {
  await requireStatus(client, cwd, reference);
  const payload = (await client.checkoutPrMerge(cwd, { method })) as unknown as {
    success: boolean;
    error: { message: string } | null;
  };
  if (!payload.success || payload.error) {
    throw bridgeError(
      "pr.merge-failed",
      payload.error?.message ?? "Pull request merge failed.",
      payload.error === null || payload.error === undefined
        ? undefined
        : { detail: payload.error.message },
    );
  }
}

export function makePullRequestHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  return {
    [WS_METHODS.pullRequestsDetail]: (payload) =>
      fromPromise("pullRequests.detail", async () => {
        const input = payload as PullRequestDetailInput;
        const context = projectContext(model, input);
        const status = await requireStatus(client, context.cwd, String(input.number));
        const [timeline, durationsByCheckRunId] = await Promise.all([
          readTimeline(client, context.cwd, status).catch(() => null),
          readCheckDurations(client, context.cwd, status),
        ]);
        return toPullRequestDetail(
          status,
          timeline,
          {
            projectId: input.projectId,
            projectTitle: context.projectTitle,
            workspaceRoot: context.cwd,
            repository: context.repository,
          },
          durationsByCheckRunId,
        ) satisfies PullRequestDetail;
      }),

    // The forge's check-details route doubles as the pipeline drill-down (the app's
    // `use-pipeline` uses the same call). The detail already carries the pipeline summary,
    // so this handler only loads the jobs.
    [WS_METHODS.pullRequestsPipeline]: (payload) =>
      fromPromise("pullRequests.pipeline", async () => {
        const input = payload as PullRequestPipelineInput;
        try {
          const details = await client.checkoutForgeGetCheckDetails({
            cwd: input.cwd,
            checkRunId: input.pipelineId,
            changeRequestNumber: input.changeRequestNumber,
          });
          if (!details.success) {
            return {
              pipeline: null,
              error: details.error?.message?.trim() || "Could not load pipeline jobs.",
            } satisfies PullRequestPipelineResult;
          }
          return {
            pipeline: toPullRequestPipeline(details.details?.pipeline),
            error: null,
          } satisfies PullRequestPipelineResult;
        } catch (error) {
          return {
            pipeline: null,
            error: error instanceof Error ? error.message : "Could not load pipeline jobs.",
          } satisfies PullRequestPipelineResult;
        }
      }),

    [WS_METHODS.pullRequestsDiff]: (payload) =>
      fromPromise("pullRequests.diff", async () => {
        const input = payload as PullRequestDetailInput;
        const context = projectContext(model, input);
        const status = await requireStatus(client, context.cwd, String(input.number));
        const diff = (await client.getCheckoutDiff(context.cwd, {
          mode: "all",
          baseRef: status.baseRefName,
        })) as unknown as NeolixDiffPayload;
        if (diff.error) {
          throw bridgeError("pr.diff-failed", diff.error.message, { detail: diff.error.message });
        }
        return {
          patch: renderUnifiedPatch(diff.files),
          truncated: diff.diffTooLarge === true,
        } satisfies PullRequestDiffResult;
      }),

    [WS_METHODS.pullRequestsAction]: (payload) =>
      fromPromise("pullRequests.action", async () => {
        const input = payload as {
          projectId: string;
          repository: string;
          number: number;
          action: "merge" | "ready" | "draft" | "close" | "reopen";
          mergeMethod?: PullRequestMergeMethod;
        };
        const context = projectContext(model, input as unknown as PullRequestDetailInput);
        if (input.action !== "merge") {
          throw bridgeError(
            "pr.state-change-unsupported",
            `Neox cannot change a pull request to ${input.action}.`,
            { action: input.action },
          );
        }
        await mergeForReference(
          client,
          context.cwd,
          String(input.number),
          input.mergeMethod ?? "merge",
        );
        return {
          projectId: input.projectId as never,
          repository: input.repository,
          number: input.number,
          workspaceRoot: context.cwd,
          mergeOutcome: null,
        } satisfies PullRequestActionResult;
      }),

    [WS_METHODS.pullRequestsSetAutoMerge]: (payload) =>
      fromPromise("pullRequests.setAutoMerge", async () => {
        const input = payload as PullRequestSetAutoMergeInput;
        const context = projectContext(model, input);
        await requireStatus(client, context.cwd, String(input.number));
        const result = (await client.checkoutForgeSetAutoMerge(
          context.cwd,
          input.enabled
            ? { enabled: true, method: input.mergeMethod ?? "merge" }
            : { enabled: false },
        )) as unknown as { success: boolean; error: { message: string } | null };
        if (!result.success || result.error) {
          throw bridgeError(
            "pr.auto-merge-failed",
            result.error?.message ?? "Updating auto-merge failed.",
            result.error === null || result.error === undefined
              ? undefined
              : { detail: result.error.message },
          );
        }
        return {
          projectId: input.projectId,
          repository: input.repository,
          number: input.number,
          workspaceRoot: context.cwd,
          mergeOutcome: null,
        } satisfies PullRequestActionResult;
      }),

    // Neox has no comment, pin, or auto-fix routes for pull requests.
    [WS_METHODS.pullRequestsComment]: () =>
      Effect.fail(notSupported(WS_METHODS.pullRequestsComment)),
    [WS_METHODS.pullRequestsSetPinned]: () =>
      Effect.fail(notSupported(WS_METHODS.pullRequestsSetPinned)),

    [WS_METHODS.gitResolvePullRequest]: (payload) =>
      fromPromise("git.resolvePullRequest", async () => {
        const input = payload as { cwd: string; reference: string };
        return {
          pullRequest: await resolveReference(client, input.cwd, input.reference),
        } satisfies GitResolvePullRequestResult;
      }),

    [WS_METHODS.gitPullRequestSnapshot]: (payload) =>
      fromPromise("git.pullRequestSnapshot", async () => {
        const input = payload as { cwd: string; reference: string };
        const status = await requireStatus(client, input.cwd, input.reference);
        const [timeline, durationsByCheckRunId] = await Promise.all([
          readTimeline(client, input.cwd, status).catch(() => null),
          readCheckDurations(client, input.cwd, status),
        ]);
        return {
          pullRequest: toGitResolvedPullRequest(status),
          checks: toGitPullRequestChecks(status, durationsByCheckRunId),
          comments: timeline
            ? toPullRequestComments(timeline, new Date().toISOString()).map((comment) => ({
                id: comment.id,
                author: comment.author?.login ?? null,
                body: comment.body,
                path: comment.path,
                url: comment.url,
                createdAt: comment.createdAt,
              }))
            : [],
          commentsTruncated: timeline?.truncated === true,
          commentsError: timeline?.error?.message?.trim() || null,
        } satisfies GitPullRequestSnapshotResult;
      }),

    // A pull request checks out into a new worktree through the daemon's `checkout` worktree
    // action (as the app's new-workspace PR picker does). Neox has no in-place PR checkout, so
    // the dialog hides "local" and the bridge refuses it.
    [WS_METHODS.gitPreparePullRequestThread]: (payload) => {
      const input = payload as { cwd: string; reference: string; mode: "local" | "worktree" };
      if (input.mode !== "worktree") {
        return Effect.fail(notSupported(`${WS_METHODS.gitPreparePullRequestThread} (local)`));
      }
      return fromPromise("git.preparePullRequestThread", async () => {
        const pullRequest = await resolveReference(client, input.cwd, input.reference);
        const created = (await client.createNeolixWorktree({
          cwd: input.cwd,
          action: "checkout",
          checkoutSource: { kind: "change_request", number: pullRequest.number },
        })) as unknown as {
          workspace?: {
            workspaceDirectory?: string;
            gitRuntime?: { currentBranch?: string | null } | null;
          } | null;
          error?: string | null;
        };
        const worktreePath = created.workspace?.workspaceDirectory?.trim();
        if (!worktreePath) {
          throw bridgeError(
            "pr.checkout-failed",
            created.error ?? `Pull request #${pullRequest.number} was not checked out.`,
            {
              number: pullRequest.number,
              ...(created.error ? { detail: created.error } : {}),
            },
          );
        }
        const branch =
          created.workspace?.gitRuntime?.currentBranch?.trim() || pullRequest.headBranch;
        model.rememberWorktree(worktreePath, branch);
        return { pullRequest, branch, worktreePath } satisfies GitPreparePullRequestThreadResult;
      });
    },
  };
}
