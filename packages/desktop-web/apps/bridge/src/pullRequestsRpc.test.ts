import { WS_METHODS } from "@synara/contracts";
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
  checks: [{ name: "ci", status: "success", url: null }],
  reviewDecision: "APPROVED",
  repoOwner: "neolix",
  repoName: "neolix",
  github: { mergeStateStatus: "CLEAN", repository: { mergeCommitAllowed: true } },
};

function makeHandlers(
  overrides: { status?: unknown; timeline?: unknown; searchItems?: unknown[] } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const client = {
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
      checks: [{ name: "ci", status: "success" }],
    });
    expect(calls).toContainEqual(["checkoutPrStatus", "/repo"]);
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
