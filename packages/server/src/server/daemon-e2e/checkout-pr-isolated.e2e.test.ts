import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * W33's PR checkout, entirely local: the repository's `origin` is a fake GitHub URL that
 * `url.<local>.insteadOf` rewrites to a bare repo on disk, and a stub `gh` answers the forge
 * calls the daemon makes. The checkout itself is the real one — `createNeolixWorktree` with a
 * `change_request` source fetches `refs/pull/7/head` from origin and builds a worktree.
 *
 * The bridge's resolution (current checkout first, forge search by number otherwise) is unit
 * tested in the desktop-web bridge; this proves the daemon side of the same calls.
 */

const PR_NUMBER = 7;
const PR_BRANCH = "feature";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
    .toString()
    .trim();
}

function initRepo(repo: string, bare = false): void {
  execFileSync("git", ["init", ...(bare ? ["--bare"] : []), "-b", "main"], {
    cwd: repo,
    stdio: "pipe",
  });
  if (bare) return;
  git(["config", "user.name", "Neox PR E2E"], repo);
  git(["config", "user.email", "pr-e2e@neolix.test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
}

function commit(repo: string, fileName: string, contents: string, message: string): void {
  writeFileSync(path.join(repo, fileName), contents);
  git(["add", fileName], repo);
  git(["commit", "-m", message], repo);
}

function writeFakeGh(directory: string): string {
  const gh = path.join(directory, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
case "$1" in
  auth)
    exit 0
    ;;
  api)
    case "$*" in
      *PullRequestCheckoutTarget*)
        printf '%s' '{"data":{"repository":{"pullRequest":{"number":${PR_NUMBER},"baseRefName":"main","headRefName":"${PR_BRANCH}","isCrossRepository":false,"headRepositoryOwner":{"login":"e2e"},"headRepository":{"sshUrl":null,"url":null}}}}}'
        ;;
      *PullRequestStatusFacts*)
        printf '%s' '{"data":{"repository":{"autoMergeAllowed":true,"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"viewerDefaultMergeMethod":"MERGE","pullRequest":{"mergeStateStatus":"CLEAN","autoMergeRequest":null,"viewerCanEnableAutoMerge":true,"viewerCanDisableAutoMerge":false,"viewerCanMergeAsAdmin":false,"viewerCanUpdateBranch":false,"isMergeQueueEnabled":false,"isInMergeQueue":false}}}}'
        ;;
      *)
        printf '%s' '{}'
        ;;
    esac
    exit 0
    ;;
  repo)
    printf '%s' '{"owner":{"login":"e2e"},"name":"fixture"}'
    exit 0
    ;;
  pr)
    if [ "$2" = "list" ]; then
      printf '%s' '[{"number":${PR_NUMBER},"title":"Fixture PR","url":"https://github.com/e2e/fixture/pull/${PR_NUMBER}","state":"OPEN","body":"","labels":[],"baseRefName":"main","headRefName":"${PR_BRANCH}","updatedAt":"2026-11-16T00:00:00Z"}]'
    else
      printf '%s' '{"number":${PR_NUMBER},"title":"Fixture PR","url":"https://github.com/e2e/fixture/pull/${PR_NUMBER}","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"${PR_BRANCH}","headRefOid":"","updatedAt":"2026-11-16T00:00:00Z","mergedAt":null,"reviewDecision":null,"mergeable":"MERGEABLE","headRepositoryOwner":{"login":"e2e"},"statusCheckRollup":[]}'
    fi
    exit 0
    ;;
esac
printf '%s' '{}'
`,
    { mode: 0o755 },
  );
  chmodSync(gh, 0o755);
  return gh;
}

describe("PR checkout from an isolated forge", () => {
  let ctx: DaemonTestContext;
  const cleanupDirectories: string[] = [];
  let basePath: string | undefined;

  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupDirectories.push(dir);
    return dir;
  };

  beforeEach(async () => {
    basePath = process.env.PATH;
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (basePath === undefined) delete process.env.PATH;
    else process.env.PATH = basePath;
    for (const dir of cleanupDirectories.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  test("resolves the PR and checks it out into a new worktree", async () => {
    const remote = tempDir("neolix-pr-remote-");
    const repo = tempDir("neolix-pr-repo-");
    const bin = tempDir("neolix-pr-gh-");
    initRepo(remote, true);
    initRepo(repo);
    commit(repo, "README.md", "main branch\n", "initial");
    git(["remote", "add", "origin", "https://github.com/e2e/fixture.git"], repo);
    // The forge still sees a github.com origin; only git's transports go to the bare repo.
    git(["config", `url.${remote}.insteadOf`, "https://github.com/e2e/fixture.git"], repo);
    git(["push", "-u", "origin", "main"], repo);

    git(["checkout", "-b", PR_BRANCH], repo);
    commit(repo, "feature-local.txt", "local feature\n", "local feature branch");
    git(["push", "origin", PR_BRANCH], repo);

    // A different commit behind refs/pull/7/head, as a force-pushed PR would be.
    git(["checkout", "main"], repo);
    git(["checkout", "-b", "pr-source"], repo);
    commit(repo, "README.md", "pull request head\n", "pr head");
    const prHead = git(["rev-parse", "HEAD"], repo);
    git(["push", "origin", "pr-source"], repo);
    execFileSync(
      "git",
      ["--git-dir", remote, "update-ref", `refs/pull/${PR_NUMBER}/head`, prHead],
      {
        stdio: "pipe",
      },
    );
    git(["checkout", PR_BRANCH], repo);

    writeFakeGh(bin);
    process.env.PATH = `${bin}${path.delimiter}${basePath ?? ""}`;

    const status = await ctx.client.checkoutPrStatus(repo);
    expect(status.error).toBeNull();
    expect(status.status).toMatchObject({
      number: PR_NUMBER,
      state: "open",
      headRefName: PR_BRANCH,
    });

    const search = await ctx.client.searchForge({
      cwd: repo,
      query: String(PR_NUMBER),
      limit: 10,
      kinds: ["change_request"],
    });
    expect(search.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "change_request", number: PR_NUMBER }),
      ]),
    );

    const created = await ctx.client.createNeolixWorktree({
      cwd: repo,
      worktreeSlug: "pr-seven",
      action: "checkout",
      checkoutSource: { kind: "change_request", number: PR_NUMBER },
    });
    expect(created.error).toBeNull();
    const worktreePath = created.workspace?.workspaceDirectory?.trim();
    expect(worktreePath).toBeTruthy();

    expect(readFileSync(path.join(worktreePath!, "README.md"), "utf8")).toBe("pull request head\n");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath!)).toMatch(/^feature/);
  });
});
