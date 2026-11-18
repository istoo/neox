import {
  GitHubRepositoryResult,
  type GitActionProgressEvent,
  GitListBranchesResult,
  GitListCommitsResult,
  GitCommitDiffResult,
  GitListRecentCommitsResult,
  GitPullResult,
  GitReadWorkingTreeDiffResult,
  GitRunStackedActionResult,
  GitStashInfoResult,
  GitStashListResult,
  GitStatusResult,
  GitWorkingTreeDiffStatsResult,
  WS_METHODS,
} from "@synara/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeGitHandlers } from "./gitRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";

const CWD = "/repo";

const STATUS = {
  isGit: true,
  currentBranch: "main",
  isDirty: true,
  baseRef: "main",
  upstreamRef: "refs/remotes/origin/main",
  aheadOfOrigin: 2,
  behindOfOrigin: 1,
  hasRemote: true,
  remoteUrl: "git@github.com:neolix/neolix.git",
  error: null,
};

const DIFF = {
  files: [
    {
      path: "src/a.ts",
      isNew: false,
      isDeleted: false,
      additions: 2,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: "header", content: "@@ -1,2 +1,3 @@" },
            { type: "context", content: "a" },
            { type: "remove", content: "b" },
            { type: "add", content: "c" },
            { type: "add", content: "d" },
          ],
        },
      ],
    },
    {
      path: "new.txt",
      isNew: true,
      isDeleted: false,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: "header", content: "@@ -0,0 +1 @@" },
            { type: "add", content: "hello" },
          ],
        },
      ],
    },
  ],
  error: null,
};

interface Fakes {
  readonly status?: Record<string, unknown>;
  readonly statusSequence?: Array<Record<string, unknown>>;
  readonly diff?: Record<string, unknown>;
  readonly branches?: Record<string, unknown>;
  readonly worktrees?: Record<string, unknown>;
  readonly commits?: unknown;
  readonly commitFiles?: Record<string, unknown>;
  readonly stashes?: Record<string, unknown>;
  readonly stashPop?: Record<string, unknown>;
  readonly prCreate?: Record<string, unknown>;
  readonly prStatus?: Record<string, unknown>;
  readonly switchError?: string;
  readonly createWorkspace?: Record<string, unknown>;
  readonly discard?: Record<string, unknown>;
  readonly merge?: Record<string, unknown>;
  readonly mergeFromBase?: Record<string, unknown>;
  readonly projectId?: string;
  readonly porcelainDirty?: boolean | null;
}

function makeHandlers(fakes: Fakes = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    getCheckoutStatus: async (cwd: string) => {
      calls.push(["getCheckoutStatus", cwd]);
      return fakes.statusSequence?.shift() ?? fakes.status ?? STATUS;
    },
    getCheckoutDiff: async (cwd: string, compare: unknown) => {
      calls.push(["getCheckoutDiff", { cwd, compare }]);
      return fakes.diff ?? DIFF;
    },
    getBranchSuggestions: async (input: unknown) => {
      calls.push(["getBranchSuggestions", input]);
      return (
        fakes.branches ?? {
          branches: ["main", "feature", "origin-only"],
          branchDetails: [
            { name: "main", hasLocal: true },
            { name: "feature", hasLocal: true },
            { name: "origin-only", hasLocal: false },
          ],
          error: null,
        }
      );
    },
    getNeolixWorktreeList: async (input: unknown) => {
      calls.push(["getNeolixWorktreeList", input]);
      return (
        fakes.worktrees ?? {
          worktrees: [{ worktreePath: "/repo-feature", branchName: "feature" }],
        }
      );
    },
    getCommitFileDiff: async (cwd: string, sha: string, filePath: string) => {
      calls.push(["getCommitFileDiff", { cwd, sha, path: filePath }]);
      return {
        file: (fakes.commitFiles?.[filePath] as Record<string, unknown> | undefined) ?? null,
      };
    },
    listCheckoutCommits: async (cwd: string) => {
      calls.push(["listCheckoutCommits", cwd]);
      return (
        fakes.commits ?? {
          baseRef: "main",
          commits: Array.from({ length: 30 }, (_, index) => ({
            sha: `sha-${index}`,
            shortSha: `sha-${index}`.slice(0, 7),
            subject: `commit ${index}`,
            authorName: "Dev",
            authorDate: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
            isOnRemote: true,
            files: [],
          })),
        }
      );
    },
    checkoutPull: async (cwd: string) => {
      calls.push(["checkoutPull", cwd]);
      return { cwd, success: true, error: null, requestId: "r" };
    },
    checkoutPush: async (cwd: string) => {
      calls.push(["checkoutPush", cwd]);
      return { cwd, success: true, error: null, requestId: "r" };
    },
    checkoutCommit: async (cwd: string, input: unknown) => {
      calls.push(["checkoutCommit", { cwd, input }]);
      return { cwd, success: true, error: null, requestId: "r" };
    },
    checkoutSwitchBranch: async (cwd: string, branch: string) => {
      calls.push(["checkoutSwitchBranch", { cwd, branch }]);
      return fakes.switchError
        ? {
            cwd,
            success: false,
            branch,
            error: { code: "checkout-failed", message: fakes.switchError },
            requestId: "r",
          }
        : { cwd, success: true, branch, error: null, requestId: "r" };
    },
    stashSave: async (cwd: string, options: unknown) => {
      calls.push(["stashSave", { cwd, options }]);
      return { cwd, success: true, error: null, requestId: "r" };
    },
    stashList: async (cwd: string, options: unknown) => {
      calls.push(["stashList", { cwd, options }]);
      return (
        fakes.stashes ?? {
          entries: [
            {
              index: 0,
              message: "neolix: stash before switching to feature",
              branch: "main",
              isNeolix: true,
            },
          ],
          error: null,
        }
      );
    },
    stashPop: async (cwd: string, stashIndex: number) => {
      calls.push(["stashPop", { cwd, stashIndex }]);
      return fakes.stashPop ?? { cwd, success: true, error: null, requestId: "r" };
    },
    checkoutPrCreate: async (cwd: string, input: unknown) => {
      calls.push(["checkoutPrCreate", { cwd, input }]);
      return (
        fakes.prCreate ?? {
          cwd,
          url: "https://github.com/neolix/neolix/pull/7",
          number: 7,
          error: null,
          requestId: "r",
        }
      );
    },
    checkoutPrStatus: async (cwd: string) => {
      calls.push(["checkoutPrStatus", cwd]);
      return fakes.prStatus ?? { status: null, error: null };
    },
    createWorkspace: async (input: unknown) => {
      calls.push(["createWorkspace", input]);
      return (
        fakes.createWorkspace ?? {
          workspace: {
            workspaceDirectory: "/worktrees/synara-abc123",
            projectRootPath: CWD,
            gitRuntime: { currentBranch: "synara/abc123" },
          },
          error: null,
        }
      );
    },
    checkoutDiscardChanges: async (cwd: string, input: unknown) => {
      calls.push(["checkoutDiscardChanges", { cwd, input }]);
      return fakes.discard ?? { cwd, success: true, error: null, requestId: "r" };
    },
    checkoutMerge: async (cwd: string, input: unknown) => {
      calls.push(["checkoutMerge", { cwd, input }]);
      return fakes.merge ?? { cwd, success: true, error: null, requestId: "r" };
    },
    checkoutMergeFromBase: async (cwd: string, input: unknown) => {
      calls.push(["checkoutMergeFromBase", { cwd, input }]);
      return fakes.mergeFromBase ?? { cwd, success: true, error: null, requestId: "r" };
    },
  } as unknown as DaemonClient;
  const model = {
    client,
    notePrStatus: () => {},
    rememberWorktree: () => {},
    projectIdForCwd: () => fakes.projectId,
  } as unknown as BridgeModel;
  return {
    handlers: makeGitHandlers(model, {
      readPorcelainDirty: async () => fakes.porcelainDirty ?? null,
    }),
    calls,
  };
}

async function call<T>(
  handlers: Record<string, (payload: unknown, options: unknown) => unknown>,
  method: string,
  payload: unknown,
): Promise<T> {
  return Effect.runPromise(handlers[method]!(payload, undefined) as Effect.Effect<T, never>);
}

async function collectStream(
  handlers: Record<string, (payload: unknown, options: unknown) => unknown>,
  method: string,
  payload: unknown,
): Promise<GitActionProgressEvent[]> {
  const stream = handlers[method]!(payload, undefined) as Stream.Stream<
    GitActionProgressEvent,
    unknown
  >;
  return [...(await Effect.runPromise(Stream.runCollect(stream)))];
}

async function collectWorktreeStream(
  handlers: Record<string, (payload: unknown, options: unknown) => unknown>,
  method: string,
  payload: unknown,
): Promise<Array<{ kind: string; progressId: string | null; result?: unknown }>> {
  const stream = handlers[method]!(payload, undefined) as Stream.Stream<never, unknown>;
  return [...(await Effect.runPromise(Stream.runCollect(stream)))] as unknown as Array<{
    kind: string;
    progressId: string | null;
    result?: unknown;
  }>;
}

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

describe("gitRpc", () => {
  it("maps checkout status and the working-tree diff into a Synara status", async () => {
    const { handlers } = makeHandlers();
    const result = await call<GitStatusResult>(handlers, WS_METHODS.gitStatus, { cwd: CWD });
    expect(() => encode(GitStatusResult, result)).not.toThrow();
    expect(result).toMatchObject({
      branch: "main",
      hasWorkingTreeChanges: true,
      upstreamBranch: "main",
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
    expect(result.workingTree.insertions).toBe(3);
    expect(result.workingTree.deletions).toBe(1);
    expect(result.workingTree.files.map((file) => file.path)).toEqual(["src/a.ts", "new.txt"]);
  });

  it("skips the diff for a clean checkout", async () => {
    const { handlers, calls } = makeHandlers({ status: { ...STATUS, isDirty: false } });
    const result = await call<GitStatusResult>(handlers, WS_METHODS.gitStatus, { cwd: CWD });
    expect(result.hasWorkingTreeChanges).toBe(false);
    expect(result.workingTree).toEqual({ files: [], insertions: 0, deletions: 0 });
    expect(calls.some(([name]) => name === "getCheckoutDiff")).toBe(false);
  });

  it("trusts git status --porcelain when the cached daemon status says clean", async () => {
    const { handlers, calls } = makeHandlers({
      status: { ...STATUS, isDirty: false },
      porcelainDirty: true,
    });
    const result = await call<GitStatusResult>(handlers, WS_METHODS.gitStatus, { cwd: CWD });
    expect(result.hasWorkingTreeChanges).toBe(true);
    expect(result.workingTree.files.map((file) => file.path)).toEqual(["src/a.ts", "new.txt"]);
    expect(calls.some(([name]) => name === "getCheckoutDiff")).toBe(true);
  });

  it("reports an empty status for a folder that is not a git repository", async () => {
    const { handlers } = makeHandlers({
      status: { ...STATUS, isGit: false, currentBranch: null, isDirty: null, baseRef: null },
    });
    const result = await call<GitStatusResult>(handlers, WS_METHODS.gitStatus, { cwd: CWD });
    expect(() => encode(GitStatusResult, result)).not.toThrow();
    expect(result).toMatchObject({
      branch: null,
      hasWorkingTreeChanges: false,
      hasUpstream: false,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
    });
    expect(result.workingTree.files).toEqual([]);
  });

  it("lists local and remote-only branches with their worktree checkout", async () => {
    const { handlers } = makeHandlers();
    const result = await call<GitListBranchesResult>(handlers, WS_METHODS.gitListBranches, {
      cwd: CWD,
    });
    expect(() => encode(GitListBranchesResult, result)).not.toThrow();
    expect(result.isRepo).toBe(true);
    expect(result.hasOriginRemote).toBe(true);
    expect(result.branches).toEqual([
      { name: "main", current: true, isDefault: true, worktreePath: null },
      { name: "feature", current: false, isDefault: false, worktreePath: "/repo-feature" },
      {
        name: "origin-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ]);
  });

  it("reports an empty branch list outside a repository", async () => {
    const { handlers } = makeHandlers({ status: { ...STATUS, isGit: false } });
    const result = await call<GitListBranchesResult>(handlers, WS_METHODS.gitListBranches, {
      cwd: CWD,
    });
    expect(() => encode(GitListBranchesResult, result)).not.toThrow();
    expect(result).toEqual({ branches: [], isRepo: false, hasOriginRemote: false });
  });

  it("totals working-tree diff stats without sending the patch", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await call<GitWorkingTreeDiffStatsResult>(
      handlers,
      WS_METHODS.gitWorkingTreeDiffStats,
      { cwd: CWD, scope: "workingTree" },
    );
    expect(() => encode(GitWorkingTreeDiffStatsResult, result)).not.toThrow();
    expect(result).toEqual({ additions: 3, deletions: 1, fileCount: 2 });
    expect(calls).toContainEqual([
      "getCheckoutDiff",
      { cwd: CWD, compare: { mode: "uncommitted" } },
    ]);
  });

  it("counts no changes in a folder that is not a git repository", async () => {
    const { handlers } = makeHandlers({
      diff: { files: [], error: { code: "NOT_GIT_REPO", message: `Not a git repository: ${CWD}` } },
    });
    const result = await call<GitWorkingTreeDiffStatsResult>(
      handlers,
      WS_METHODS.gitWorkingTreeDiffStats,
      { cwd: CWD, scope: "workingTree" },
    );
    expect(result).toEqual({ additions: 0, deletions: 0, fileCount: 0 });
  });

  it("still reports other diff failures", async () => {
    const { handlers } = makeHandlers({
      diff: { files: [], error: { code: "UNKNOWN", message: "git exploded" } },
    });
    await expect(
      call(handlers, WS_METHODS.gitWorkingTreeDiffStats, { cwd: CWD, scope: "workingTree" }),
    ).rejects.toThrow("git exploded");
  });

  it("renders a unified patch from the parsed diff and honours a file filter", async () => {
    const { handlers } = makeHandlers();
    const all = await call<GitReadWorkingTreeDiffResult>(
      handlers,
      WS_METHODS.gitReadWorkingTreeDiff,
      { cwd: CWD, scope: "workingTree" },
    );
    expect(() => encode(GitReadWorkingTreeDiffResult, all)).not.toThrow();
    expect(all.truncated).toBe(false);
    expect(all.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(all.patch).toContain("--- a/src/a.ts");
    expect(all.patch).toContain("@@ -1,2 +1,3 @@");
    expect(all.patch).toContain("-b");
    expect(all.patch).toContain("+c");
    expect(all.patch).toContain("--- /dev/null");

    const one = await call<GitReadWorkingTreeDiffResult>(
      handlers,
      WS_METHODS.gitReadWorkingTreeDiff,
      { cwd: CWD, scope: "workingTree", filePath: "new.txt" },
    );
    expect(one.patch).toContain("b/new.txt");
    expect(one.patch).not.toContain("src/a.ts");
  });

  it("compares branch and ref scopes against the working tree", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitWorkingTreeDiffStats, { cwd: CWD, scope: "branch" });
    await call(handlers, WS_METHODS.gitWorkingTreeDiffStats, {
      cwd: CWD,
      scope: "ref",
      compareRef: "origin/main",
    });
    expect(calls).toContainEqual(["getCheckoutDiff", { cwd: CWD, compare: { mode: "all" } }]);
    expect(calls).toContainEqual([
      "getCheckoutDiff",
      { cwd: CWD, compare: { mode: "all", baseRef: "origin/main" } },
    ]);
  });

  it("returns an empty staged diff because the daemon does not separate the index", async () => {
    const { handlers, calls } = makeHandlers();
    const stats = await call<GitWorkingTreeDiffStatsResult>(
      handlers,
      WS_METHODS.gitWorkingTreeDiffStats,
      { cwd: CWD, scope: "staged" },
    );
    expect(stats).toEqual({ additions: 0, deletions: 0, fileCount: 0 });
    const diff = await call<GitReadWorkingTreeDiffResult>(
      handlers,
      WS_METHODS.gitReadWorkingTreeDiff,
      { cwd: CWD, scope: "staged" },
    );
    expect(diff).toEqual({ patch: "", truncated: false });
    expect(calls.some(([name]) => name === "getCheckoutDiff")).toBe(false);
  });

  it("lists recent commits from the checkout history", async () => {
    const { handlers } = makeHandlers();
    const result = await call<GitListRecentCommitsResult>(
      handlers,
      WS_METHODS.gitListRecentCommits,
      { cwd: CWD, limit: 5 },
    );
    expect(() => encode(GitListRecentCommitsResult, result)).not.toThrow();
    expect(result.commits).toHaveLength(5);
    expect(result.commits[0]).toMatchObject({ sha: "sha-0", subject: "commit 0" });
  });

  it("lists commits with their files and base classification", async () => {
    const { handlers } = makeHandlers({
      commits: {
        baseRef: "main",
        commits: [
          {
            sha: "abc123",
            shortSha: "abc123",
            subject: "Add commit browser",
            authorName: "Dev",
            authorDate: "2026-11-01T00:00:00.000Z",
            isOnRemote: false,
            isOnBase: false,
            files: [
              { path: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
              { path: "src/b.ts", additions: 2, deletions: 0, status: "added" },
            ],
          },
        ],
      },
    });
    const result = await call<GitListCommitsResult>(handlers, WS_METHODS.gitListCommits, {
      cwd: CWD,
    });
    expect(() => encode(GitListCommitsResult, result)).not.toThrow();
    expect(result.baseRef).toBe("main");
    expect(result.commits[0]).toMatchObject({
      sha: "abc123",
      authorName: "Dev",
      isOnRemote: false,
      isOnBase: false,
    });
    expect(result.commits[0]?.files).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
      { path: "src/b.ts", additions: 2, deletions: 0, status: "added" },
    ]);
  });

  it("renders one commit's file diffs as a unified patch", async () => {
    const { handlers, calls } = makeHandlers({
      commits: {
        baseRef: "main",
        commits: [
          {
            sha: "abc123",
            shortSha: "abc123",
            subject: "Add commit browser",
            authorName: "Dev",
            authorDate: "2026-11-01T00:00:00.000Z",
            isOnRemote: true,
            files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
          },
        ],
      },
      commitFiles: { "src/a.ts": DIFF.files[0] },
    });
    const result = await call<GitCommitDiffResult>(handlers, WS_METHODS.gitCommitDiff, {
      cwd: CWD,
      sha: "abc123",
    });
    expect(() => encode(GitCommitDiffResult, result)).not.toThrow();
    expect(result.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.patch).toContain("+d");
    expect(calls).toContainEqual([
      "getCommitFileDiff",
      { cwd: CWD, sha: "abc123", path: "src/a.ts" },
    ]);
  });

  it("keeps a binary commit file visible instead of returning an empty patch", async () => {
    const { handlers } = makeHandlers({
      commits: {
        baseRef: "main",
        commits: [
          {
            sha: "abc123",
            shortSha: "abc123",
            subject: "Add logo",
            authorName: "Dev",
            authorDate: "2026-11-01T00:00:00.000Z",
            isOnRemote: true,
            files: [{ path: "assets/logo.png", additions: 0, deletions: 0, status: "added" }],
          },
        ],
      },
      commitFiles: {
        "assets/logo.png": {
          path: "assets/logo.png",
          isNew: true,
          isDeleted: false,
          additions: 0,
          deletions: 0,
          hunks: [],
          status: "binary",
        },
      },
    });
    const result = await call<GitCommitDiffResult>(handlers, WS_METHODS.gitCommitDiff, {
      cwd: CWD,
      sha: "abc123",
    });
    expect(result.patch).toContain("diff --git a/assets/logo.png b/assets/logo.png");
    expect(result.patch).toContain("Binary files /dev/null and b/assets/logo.png differ");
  });

  it("reads the GitHub repository from the checkout remote", async () => {
    const { handlers } = makeHandlers();
    const result = await call<GitHubRepositoryResult>(handlers, WS_METHODS.gitGithubRepository, {
      cwd: CWD,
    });
    expect(() => encode(GitHubRepositoryResult, result)).not.toThrow();
    expect(result.repository).toEqual({
      nameWithOwner: "neolix/neolix",
      url: "https://github.com/neolix/neolix",
    });
    expect(result.repositories).toHaveLength(1);
  });

  it("still pulls when the cached behind count says up to date", async () => {
    // The count comes from the daemon's last fetch; skipping the pull would never fetch.
    const { handlers, calls } = makeHandlers({ status: { ...STATUS, behindOfOrigin: 0 } });
    const result = await call<GitPullResult>(handlers, WS_METHODS.gitPull, { cwd: CWD });
    expect(() => encode(GitPullResult, result)).not.toThrow();
    expect(result).toEqual({ status: "pulled", branch: "main", upstreamBranch: "main" });
    expect(calls).toContainEqual(["checkoutPull", CWD]);
  });

  it("pulls behind branches and reports the post-pull identity", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await call<GitPullResult>(handlers, WS_METHODS.gitPull, { cwd: CWD });
    expect(() => encode(GitPullResult, result)).not.toThrow();
    expect(result).toEqual({ status: "pulled", branch: "main", upstreamBranch: "main" });
    expect(calls).toContainEqual(["checkoutPull", CWD]);
  });

  it("switches branches through checkout", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitCheckout, { cwd: CWD, branch: "feature" });
    expect(calls).toContainEqual(["checkoutSwitchBranch", { cwd: CWD, branch: "feature" }]);
  });

  it("translates Neox's dirty-checkout error into the fork's recovery shape", async () => {
    const { handlers } = makeHandlers({
      switchError:
        "Working directory has uncommitted changes. Commit or stash before switching branches.",
    });
    await expect(
      call(handlers, WS_METHODS.gitCheckout, { cwd: CWD, branch: "feature" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "Uncommitted changes block checkout to feature:\n- src/a.ts\n- new.txt",
      ),
    });
  });

  it("stashes with the source branch tag before switching", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitStashAndCheckout, { cwd: CWD, branch: "feature" });
    expect(calls).toContainEqual(["stashSave", { cwd: CWD, options: { branch: "main" } }]);
    expect(calls.indexOf(calls.find(([name]) => name === "stashSave")!)).toBeLessThan(
      calls.indexOf(calls.find(([name]) => name === "checkoutSwitchBranch")!),
    );
  });

  it("reports the newest stash with a git-compatible reference", async () => {
    const { handlers } = makeHandlers();
    const result = await call<GitStashInfoResult>(handlers, WS_METHODS.gitStashInfo, {
      cwd: CWD,
    });
    expect(() => encode(GitStashInfoResult, result)).not.toThrow();
    expect(result).toMatchObject({
      cwd: CWD,
      branch: "main",
      stashRef: "stash@{0}",
      message: "neolix: stash before switching to feature",
      files: [],
    });
  });

  it("lists neolix stashes tagged with their source branch", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await call<GitStashListResult>(handlers, WS_METHODS.gitStashList, { cwd: CWD });
    expect(() => encode(GitStashListResult, result)).not.toThrow();
    expect(result).toEqual({
      entries: [
        {
          index: 0,
          message: "neolix: stash before switching to feature",
          branch: "main",
        },
      ],
    });
    expect(calls).toContainEqual(["stashList", { cwd: CWD, options: { neolixOnly: true } }]);
  });

  it("pops a stash by its git-compatible reference", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitStashPop, { cwd: CWD, stashRef: "stash@{2}" });
    expect(calls).toContainEqual(["stashPop", { cwd: CWD, stashIndex: 2 }]);
  });

  it("rejects a malformed stash reference", async () => {
    const { handlers } = makeHandlers();
    await expect(
      call(handlers, WS_METHODS.gitStashPop, { cwd: CWD, stashRef: "HEAD@{1}" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("not a stash reference") });
  });

  it("creates a detached worktree stream from a workspace worktree checkout", async () => {
    const { handlers, calls } = makeHandlers();
    const events = await collectWorktreeStream(handlers, WS_METHODS.gitCreateDetachedWorktree, {
      cwd: CWD,
      ref: "main",
      path: null,
      newBranch: "synara/abc123",
      progressId: "progress-1",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "phase_started",
      "phase_started",
      "completed",
    ]);
    expect(events.map((event) => event.progressId)).toEqual([
      "progress-1",
      "progress-1",
      "progress-1",
    ]);
    expect(events[2]?.result).toEqual({
      worktree: {
        path: "/worktrees/synara-abc123",
        ref: "main",
        branch: "synara/abc123",
      },
    });
    expect(calls).toContainEqual([
      "createWorkspace",
      {
        source: {
          kind: "worktree",
          cwd: CWD,
          action: "branch-off",
          refName: "main",
          branchName: "synara/abc123",
        },
      },
    ]);
  });

  it("refuses a custom worktree path instead of silently ignoring it", async () => {
    const { handlers } = makeHandlers();
    await expect(
      collectWorktreeStream(handlers, WS_METHODS.gitCreateDetachedWorktree, {
        cwd: CWD,
        ref: "main",
        path: "/tmp/custom",
      }),
    ).rejects.toThrow(/custom path is not supported/);
  });

  it("creates a worktree on an existing branch through the workspace source", async () => {
    const { handlers, calls } = makeHandlers({
      projectId: "prj_1",
      createWorkspace: {
        workspace: {
          workspaceDirectory: "/worktrees/feature",
          projectRootPath: CWD,
          gitRuntime: { currentBranch: "feature" },
        },
        error: null,
      },
    });
    const result = await call<{ worktree: { path: string; branch: string } }>(
      handlers,
      WS_METHODS.gitCreateWorktree,
      { cwd: CWD, branch: "feature", path: null },
    );
    expect(result).toEqual({ worktree: { path: "/worktrees/feature", branch: "feature" } });
    expect(calls).toContainEqual([
      "createWorkspace",
      {
        source: {
          kind: "worktree",
          cwd: CWD,
          projectId: "prj_1",
          action: "checkout",
          refName: "feature",
        },
      },
    ]);
  });

  it("discards the requested paths through the checkout route", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitDiscardChanges, {
      cwd: CWD,
      paths: ["src/a.ts", "old/a.ts"],
    });
    expect(calls).toContainEqual([
      "checkoutDiscardChanges",
      { cwd: CWD, input: { paths: ["src/a.ts", "old/a.ts"] } },
    ]);
  });

  it("merges the branch locally into the base ref", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitMergeLocally, { cwd: CWD, baseRef: "main" });
    expect(calls).toContainEqual([
      "checkoutMerge",
      {
        cwd: CWD,
        input: { baseRef: "main", strategy: "merge", requireCleanTarget: true },
      },
    ]);
  });

  it("updates the branch from the base ref", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, WS_METHODS.gitMergeFromBase, { cwd: CWD, baseRef: "main" });
    expect(calls).toContainEqual([
      "checkoutMergeFromBase",
      { cwd: CWD, input: { baseRef: "main", requireCleanTarget: true } },
    ]);
  });

  it("surfaces daemon merge and discard failures", async () => {
    const merge = makeHandlers({
      merge: { cwd: CWD, success: false, error: { message: "conflict" }, requestId: "r" },
    });
    await expect(
      call(merge.handlers, WS_METHODS.gitMergeLocally, { cwd: CWD, baseRef: "main" }),
    ).rejects.toThrow("conflict");

    const discard = makeHandlers({
      discard: { cwd: CWD, success: false, error: { message: "path is ignored" }, requestId: "r" },
    });
    await expect(
      call(discard.handlers, WS_METHODS.gitDiscardChanges, { cwd: CWD, paths: ["a.txt"] }),
    ).rejects.toThrow("path is ignored");
  });

  it("commits the working tree as a streamed stacked action", async () => {
    const { handlers, calls } = makeHandlers();
    const events = await collectStream(handlers, WS_METHODS.gitRunStackedAction, {
      actionId: "action-1",
      cwd: CWD,
      action: "commit",
      commitMessage: "Add a feature",
    });
    expect(events[0]).toMatchObject({ kind: "action_started", phases: ["commit"] });
    expect(events.some((event) => event.kind === "phase_started" && event.phase === "commit")).toBe(
      true,
    );
    const finished = events.at(-1);
    expect(finished?.kind).toBe("action_finished");
    if (finished?.kind !== "action_finished") throw new Error("missing action_finished");
    expect(() => encode(GitRunStackedActionResult, finished.result)).not.toThrow();
    expect(finished.result).toMatchObject({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: { status: "created", commitSha: "sha-0" },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
    });
    expect(calls).toContainEqual([
      "checkoutCommit",
      { cwd: CWD, input: { addAll: true, message: "Add a feature" } },
    ]);
  });

  it("commits when the cached status is clean but git sees changes", async () => {
    const { handlers, calls } = makeHandlers({
      status: { ...STATUS, isDirty: false },
      porcelainDirty: true,
    });
    const events = await collectStream(handlers, WS_METHODS.gitRunStackedAction, {
      actionId: "action-2",
      cwd: CWD,
      action: "commit",
      commitMessage: "Commit despite a stale status",
    });
    const finished = events.at(-1);
    if (finished?.kind !== "action_finished") throw new Error("missing action_finished");
    expect(finished.result.commit).toMatchObject({ status: "created" });
    expect(calls).toContainEqual([
      "checkoutCommit",
      { cwd: CWD, input: { addAll: true, message: "Commit despite a stale status" } },
    ]);
  });

  it("pushes before creating a PR and fills the result from the forge status", async () => {
    const { handlers, calls } = makeHandlers({
      prStatus: {
        status: {
          number: 7,
          url: "https://github.com/neolix/neolix/pull/7",
          title: "Add a feature",
          state: "open",
          baseRefName: "main",
          headRefName: "feature",
          isMerged: false,
          mergeable: "MERGEABLE",
        },
        error: null,
      },
    });
    const events = await collectStream(handlers, WS_METHODS.gitRunStackedAction, {
      actionId: "action-2",
      cwd: CWD,
      action: "create_pr",
      allowDirtyWorkingTree: true,
      prTitle: "Add a feature",
    });
    const finished = events.at(-1);
    if (finished?.kind !== "action_finished") throw new Error("missing action_finished");
    expect(finished.result).toMatchObject({
      action: "create_pr",
      push: { status: "pushed" },
      pr: {
        status: "created",
        url: "https://github.com/neolix/neolix/pull/7",
        number: 7,
        baseBranch: "main",
        headBranch: "feature",
        title: "Add a feature",
      },
    });
    expect(calls.some(([name]) => name === "checkoutPush")).toBe(true);
    expect(calls.some(([name]) => name === "checkoutPrCreate")).toBe(true);
  });

  it("cannot create a branch in place", async () => {
    const { handlers } = makeHandlers();
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.gitCreateBranch]!(
          { cwd: CWD, branch: "feature" },
          undefined,
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
  });

  it("does not invent file-at-revision or blame data", async () => {
    const { handlers } = makeHandlers();
    for (const method of [WS_METHODS.gitReadFileAtRev, WS_METHODS.gitBlameLine]) {
      await expect(
        Effect.runPromise(
          handlers[method]!({ cwd: CWD }, undefined) as Effect.Effect<unknown, never>,
        ),
      ).rejects.toMatchObject({ code: "neolix.not-supported" });
    }
  });
});
