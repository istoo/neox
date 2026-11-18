import { WS_METHODS, type PullRequestPipelineResult } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { makePullRequestHandlers } from "./pullRequestsRpc.ts";
import {
  mergeabilityOf,
  pullRequestMatchesReference,
  pullRequestNumber,
  toGitStatusPr,
} from "./prTranslate.ts";

const STATUS = {
  forge: "github",
  number: 42,
  url: "https://github.com/neolix/neolix/pull/42",
  title: "Add plugin management",
  state: "open",
  baseRefName: "main",
  headRefName: "feature/plugins",
  isMerged: false,
  isDraft: false,
  mergeable: "MERGEABLE" as const,
  checks: [{ name: "ci", status: "success", url: null, duration: "1m 4s" }],
  reviewDecision: "APPROVED",
  repoOwner: "neolix",
  repoName: "neolix",
  github: { mergeStateStatus: "CLEAN", repository: { mergeCommitAllowed: true } },
};

function makeHandlers(
  overrides: {
    status?: unknown;
    timeline?: unknown;
    searchItems?: unknown[];
    checkDetails?: unknown;
    checkDetailsError?: string;
  } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    checkoutForgeGetCheckDetails: async (input: unknown) => {
      calls.push(["checkoutForgeGetCheckDetails", input]);
      if (overrides.checkDetailsError) {
        throw new Error(overrides.checkDetailsError);
      }
      return (
        overrides.checkDetails ?? {
          success: true,
          error: null,
          details: null,
        }
      );
    },
    checkoutPrStatus: async (cwd: string) => {
      calls.push(["checkoutPrStatus", cwd]);
      return { cwd, status: overrides.status ?? STATUS, error: null };
    },
    getCheckoutDiff: async (cwd: string, compare: unknown) => {
      calls.push(["getCheckoutDiff", { cwd, compare }]);
      return {
        files: [
          {
            path: "a.ts",
            isNew: false,
            isDeleted: false,
            additions: 1,
            deletions: 0,
            hunks: [
              {
                oldStart: 1,
                oldCount: 0,
                newStart: 1,
                newCount: 1,
                lines: [
                  { type: "header", content: "@@ -1,0 +1 @@" },
                  { type: "add", content: "x" },
                ],
              },
            ],
          },
        ],
        error: null,
      };
    },
    pullRequestTimeline: async (input: unknown) => {
      calls.push(["pullRequestTimeline", input]);
      return (
        overrides.timeline ?? {
          prNumber: 42,
          truncated: false,
          error: null,
          items: [
            {
              id: "c1",
              kind: "comment",
              author: "mo",
              body: "Looks good",
              createdAt: 1_700_000_000_000,
              url: "https://github.com/neolix/neolix/pull/42#c1",
            },
          ],
        }
      );
    },
    checkoutPrMerge: async (cwd: string, input: unknown) => {
      calls.push(["checkoutPrMerge", { cwd, input }]);
      return { success: true, error: null };
    },
    checkoutForgeSetAutoMerge: async (cwd: string, input: unknown) => {
      calls.push(["checkoutForgeSetAutoMerge", { cwd, input }]);
      return { success: true, enabled: (input as { enabled: boolean }).enabled, error: null };
    },
    searchForge: async (input: unknown) => {
      calls.push(["searchForge", input]);
      return { items: overrides.searchItems ?? [], error: null };
    },
    createNeolixWorktree: async (input: unknown) => {
      calls.push(["createNeolixWorktree", input]);
      return {
        workspace: {
          workspaceDirectory: "/worktrees/pr-43",
          gitRuntime: { currentBranch: "fix/login" },
        },
        error: null,
      };
    },
  } as unknown as DaemonClient;
  const model = {
    client,
    projectRoot: () => "/repo",
    shellSnapshot: () => ({ projects: [] }),
    rememberWorktree: (path: string, branch: string | null) => {
      calls.push(["rememberWorktree", { path, branch }]);
    },
  } as unknown as BridgeModel;
  return { handlers: makePullRequestHandlers(model), calls };
}

const run = <A>(effect: unknown) => Effect.runPromise(effect as Effect.Effect<A>);

describe("prTranslate", () => {
  it("parses references and maps mergeability", () => {
    expect(pullRequestNumber(STATUS)).toBe(42);
    expect(pullRequestMatchesReference(STATUS, "https://github.com/neolix/neolix/pull/42")).toBe(
      true,
    );
    expect(pullRequestMatchesReference(STATUS, "43")).toBe(false);
    expect(mergeabilityOf(STATUS)).toBe("mergeable");
    expect(toGitStatusPr(STATUS)).toMatchObject({
      number: 42,
      state: "open",
      mergeability: "mergeable",
      additions: null,
    });
  });
});

describe("pullRequestsRpc", () => {
  it("builds a detail from the checkout status and timeline", async () => {
    const { handlers, calls } = makeHandlers();
    const detail = await run(
      handlers[WS_METHODS.pullRequestsDetail]!(
        { projectId: "prj_1", repository: "neolix/neolix", number: 42 },
        undefined,
      ),
    );
    expect(detail).toMatchObject({
      number: 42,
      title: "Add plugin management",
      repository: "neolix/neolix",
      workspaceRoot: "/repo",
      mergeStateStatus: "CLEAN",
      comments: [{ id: "c1", body: "Looks good" }],
      checks: [{ name: "ci", status: "success", duration: "1m 4s" }],
    });
    expect(calls).toContainEqual(["checkoutPrStatus", "/repo"]);
  });

  it("keeps each check's forge-formatted duration", async () => {
    const { handlers } = makeHandlers({
      status: {
        ...STATUS,
        checks: [
          { name: "build", status: "success", url: "https://example.com/1", duration: "1m 4s" },
          { name: "lint", status: "pending", url: null, duration: "7m" },
        ],
      },
    });
    const detail = await run<{ checks: unknown }>(
      handlers[WS_METHODS.gitPullRequestSnapshot]!({ cwd: "/repo", reference: "42" }, undefined),
    );
    expect(detail.checks).toEqual([
      { name: "build", status: "success", url: "https://example.com/1", duration: "1m 4s" },
      { name: "lint", status: "pending", url: null, duration: "7m" },
    ]);
  });

  it("fills GitLab check durations from the pipeline's job details", async () => {
    const { handlers, calls } = makeHandlers({
      status: {
        ...STATUS,
        forge: "gitlab",
        checks: [
          { name: "build", status: "success", url: "https://gitlab/build/101", checkRunId: 101 },
          { name: "lint", status: "pending", url: "https://gitlab/build/102", checkRunId: 102 },
        ],
        forgeSpecific: { pipelineId: 777 },
      },
      checkDetails: {
        success: true,
        error: null,
        details: {
          pipeline: {
            id: 777,
            status: "running",
            stages: [
              {
                name: "verify",
                status: "running",
                jobs: [
                  { id: 101, name: "build", status: "success", durationSeconds: 64 },
                  { id: 102, name: "lint", status: "running", durationSeconds: 7 },
                  { id: 103, name: "deploy", status: "skipped", durationSeconds: null },
                ],
              },
            ],
          },
        },
      },
    });
    const detail = await run<{ checks: unknown }>(
      handlers[WS_METHODS.gitPullRequestSnapshot]!({ cwd: "/repo", reference: "42" }, undefined),
    );
    expect(detail.checks).toEqual([
      { name: "build", status: "success", url: "https://gitlab/build/101", duration: "1m 4s" },
      { name: "lint", status: "pending", url: "https://gitlab/build/102", duration: "7s" },
    ]);
    expect(calls).toContainEqual([
      "checkoutForgeGetCheckDetails",
      { cwd: "/repo", checkRunId: 777, changeRequestNumber: 42 },
    ]);
  });

  it("carries the pipeline summary on the pull request detail", async () => {
    const { handlers } = makeHandlers({
      status: {
        ...STATUS,
        forge: "gitlab",
        forgeSpecific: {
          pipelineId: 777,
          pipelineStatus: "running",
          pipelineUrl: "https://gitlab.example/pipelines/777",
        },
      },
    });
    const detail = await run<{ pipeline: unknown }>(
      handlers[WS_METHODS.pullRequestsDetail]!(
        { projectId: "prj_1", repository: "neolix/neolix", number: 42 },
        undefined,
      ),
    );
    expect(detail.pipeline).toEqual({
      id: 777,
      status: "running",
      url: "https://gitlab.example/pipelines/777",
    });
  });

  it("maps the forge pipeline into stage and job groups", async () => {
    const { handlers } = makeHandlers({
      status: {
        ...STATUS,
        forge: "gitlab",
        forgeSpecific: {
          pipelineId: 777,
          pipelineStatus: "success",
          pipelineUrl: "https://gitlab.example/pipelines/777",
        },
      },
      checkDetails: {
        success: true,
        error: null,
        details: {
          pipeline: {
            id: 777,
            status: "success",
            url: "https://gitlab.example/pipelines/777",
            ref: "main",
            sha: "abc123",
            stages: [
              {
                name: "verify",
                status: "success",
                jobs: [
                  {
                    id: 101,
                    name: "build",
                    stage: "verify",
                    status: "success",
                    url: "https://gitlab.example/jobs/101",
                    allowFailure: false,
                    durationSeconds: 64,
                  },
                  {
                    id: 102,
                    name: "deploy",
                    stage: "verify",
                    status: "manual",
                    url: null,
                    allowFailure: true,
                    durationSeconds: null,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const result = await run<PullRequestPipelineResult>(
      handlers[WS_METHODS.pullRequestsPipeline]!(
        { cwd: "/repo", pipelineId: 777, changeRequestNumber: 42 },
        undefined,
      ),
    );
    expect(result.error).toBeNull();
    expect(result.pipeline).toEqual({
      id: 777,
      status: "success",
      url: "https://gitlab.example/pipelines/777",
      ref: "main",
      sha: "abc123",
      stages: [
        {
          name: "verify",
          status: "success",
          jobs: [
            {
              id: 101,
              name: "build",
              stage: "verify",
              status: "success",
              url: "https://gitlab.example/jobs/101",
              allowFailure: false,
              durationSeconds: 64,
            },
            {
              id: 102,
              name: "deploy",
              stage: "verify",
              status: "manual",
              url: null,
              allowFailure: true,
              durationSeconds: null,
            },
          ],
        },
      ],
    });
  });

  it("reports no jobs when the forge has no pipeline details", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await run<PullRequestPipelineResult>(
      handlers[WS_METHODS.pullRequestsPipeline]!(
        { cwd: "/repo", pipelineId: 777, changeRequestNumber: 42 },
        undefined,
      ),
    );
    expect(result).toEqual({ pipeline: null, error: null });
    expect(calls).toContainEqual([
      "checkoutForgeGetCheckDetails",
      { cwd: "/repo", checkRunId: 777, changeRequestNumber: 42 },
    ]);
  });

  it("surfaces the forge error while the summary stays on the detail", async () => {
    const { handlers } = makeHandlers({ checkDetailsError: "forge unavailable" });
    const result = await run<PullRequestPipelineResult>(
      handlers[WS_METHODS.pullRequestsPipeline]!(
        { cwd: "/repo", pipelineId: 777, changeRequestNumber: 42 },
        undefined,
      ),
    );
    expect(result.pipeline).toBeNull();
    expect(result.error).toBe("forge unavailable");
  });

  it("reports a reference neither the checkout nor the forge search knows", async () => {
    const { handlers } = makeHandlers();
    await expect(
      run(
        handlers[WS_METHODS.gitResolvePullRequest]!({ cwd: "/repo", reference: "43" }, undefined),
      ),
    ).rejects.toThrow("Pull request #43 was not found.");
  });

  it("checks another pull request out into a new worktree through the forge search", async () => {
    const { handlers, calls } = makeHandlers({
      searchItems: [
        {
          kind: "change_request",
          number: 43,
          title: "Fix login",
          url: "https://github.com/neolix/neolix/pull/43",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "fix/login",
        },
      ],
    });
    const prepared = await run(
      handlers[WS_METHODS.gitPreparePullRequestThread]!(
        { cwd: "/repo", reference: "#43", mode: "worktree" },
        undefined,
      ),
    );
    expect(prepared).toEqual({
      pullRequest: expect.objectContaining({ number: 43, state: "open", headBranch: "fix/login" }),
      branch: "fix/login",
      worktreePath: "/worktrees/pr-43",
    });
    expect(calls).toContainEqual([
      "createNeolixWorktree",
      { cwd: "/repo", action: "checkout", checkoutSource: { kind: "change_request", number: 43 } },
    ]);
    expect(calls).toContainEqual([
      "rememberWorktree",
      { path: "/worktrees/pr-43", branch: "fix/login" },
    ]);
    await expect(
      run(
        handlers[WS_METHODS.gitPreparePullRequestThread]!(
          { cwd: "/repo", reference: "#43", mode: "local" },
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("local") });
  });

  it("resolves and snapshots the checked-out pull request", async () => {
    const { handlers } = makeHandlers();
    const resolved = await run(
      handlers[WS_METHODS.gitResolvePullRequest]!(
        { cwd: "/repo", reference: STATUS.url },
        undefined,
      ),
    );
    expect(resolved).toMatchObject({ pullRequest: { number: 42, state: "open" } });

    const snapshot = await run(
      handlers[WS_METHODS.gitPullRequestSnapshot]!({ cwd: "/repo", reference: "42" }, undefined),
    );
    expect(snapshot).toMatchObject({
      pullRequest: { number: 42 },
      checks: [{ name: "ci", status: "success" }],
      comments: [{ id: "c1", author: "mo" }],
      commentsTruncated: false,
    });
  });

  it("renders the checkout diff against the PR base", async () => {
    const { handlers, calls } = makeHandlers();
    const diff = await run(
      handlers[WS_METHODS.pullRequestsDiff]!(
        { projectId: "prj_1", repository: "neolix/neolix", number: 42 },
        undefined,
      ),
    );
    expect(diff).toMatchObject({ truncated: false });
    expect((diff as { patch: string }).patch).toContain("+x");
    expect(calls).toContainEqual([
      "getCheckoutDiff",
      { cwd: "/repo", compare: { mode: "all", baseRef: "main" } },
    ]);
  });

  it("merges with the requested method and refuses unsupported actions", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await run(
      handlers[WS_METHODS.pullRequestsAction]!(
        {
          projectId: "prj_1",
          repository: "neolix/neolix",
          number: 42,
          action: "merge",
          mergeMethod: "squash",
        },
        undefined,
      ),
    );
    expect(result).toMatchObject({ number: 42, workspaceRoot: "/repo", mergeOutcome: null });
    expect(calls).toContainEqual([
      "checkoutPrMerge",
      { cwd: "/repo", input: { method: "squash" } },
    ]);

    await expect(
      run(
        handlers[WS_METHODS.pullRequestsAction]!(
          { projectId: "prj_1", repository: "neolix/neolix", number: 42, action: "close" },
          undefined,
        ),
      ),
    ).rejects.toThrow("cannot change a pull request to close");
  });

  it("enables and disables forge auto-merge on the checkout's pull request", async () => {
    const { handlers, calls } = makeHandlers();
    const input = {
      projectId: "prj_1",
      repository: "neolix/neolix",
      number: 42,
    };

    const enabled = await run(
      handlers[WS_METHODS.pullRequestsSetAutoMerge]!(
        { ...input, enabled: true, mergeMethod: "squash" },
        undefined,
      ),
    );
    expect(enabled).toMatchObject({ number: 42, workspaceRoot: "/repo", mergeOutcome: null });
    expect(calls).toContainEqual([
      "checkoutForgeSetAutoMerge",
      { cwd: "/repo", input: { enabled: true, method: "squash" } },
    ]);

    await run(
      handlers[WS_METHODS.pullRequestsSetAutoMerge]!({ ...input, enabled: false }, undefined),
    );
    expect(calls).toContainEqual([
      "checkoutForgeSetAutoMerge",
      { cwd: "/repo", input: { enabled: false } },
    ]);
  });

  it("refuses comment and pin routes Neox does not implement", async () => {
    const { handlers } = makeHandlers();
    await expect(
      run(
        handlers[WS_METHODS.pullRequestsComment]!(
          {
            projectId: "prj_1",
            repository: "neolix/neolix",
            number: 42,
            body: "hello",
          },
          undefined,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      run(
        handlers[WS_METHODS.pullRequestsSetPinned]!(
          { projectId: "prj_1", repository: "neolix/neolix", number: 42, isPinned: true },
          undefined,
        ),
      ),
    ).rejects.toThrow();
  });
});
