// Git reads and writes the Synara front end makes. Neox has checkout status, one consolidated
// working-tree diff, branch suggestions, worktree/workspace creation, commit history,
// pull/push/commit/checkout, merge, discard, stashes and PR creation, but no per-scope
// (staged/unstaged) diff, branch creation, index-lock removal, stash drop, git init, selective
// commits, draft PRs or file-at-revision/blame routes; those stay typed "not supported" rather
// than being invented here.
import {
  WS_METHODS,
  type GitActionProgressEvent,
  type GitActionProgressPhase,
  type GitCommit,
  type GitCommitDiffResult,
  type GitCreateDetachedWorktreeInput,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitDiscardChangesInput,
  type GitHubRepositoryResult,
  type GitListBranchesResult,
  type GitListCommitsResult,
  type GitListRecentCommitsResult,
  type GitMergeFromBaseInput,
  type GitMergeLocallyInput,
  type GitPullResult,
  type GitReadWorkingTreeDiffResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStashInfoResult,
  type GitStatusResult,
  type GitWorkingTreeDiffStatsResult,
  type GitWorktreeSetupProgressEvent,
  WsRpcError,
} from "@synara/contracts";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import { Cause, Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { toGitStatusPr, type NeolixPrStatusPayload } from "./prTranslate.ts";
import { bridgeError, codedError, fromPromise, rpcError } from "./rpcErrors.ts";
import { notSupported, type AnyHandler } from "./stubs.ts";

// Neox wire shapes the bridge reads. They are declared here so the bridge does not depend on
// the daemon's generated protocol types for a handful of read-only payloads.
interface NeolixCheckoutStatus {
  readonly isGit: boolean;
  readonly currentBranch: string | null;
  readonly isDirty: boolean | null;
  readonly baseRef: string | null;
  readonly upstreamRef?: string | null;
  readonly aheadOfOrigin: number | null;
  readonly behindOfOrigin: number | null;
  readonly hasRemote: boolean;
  readonly remoteUrl: string | null;
  readonly error: { readonly message: string } | null;
}

interface NeolixDiffLine {
  readonly type: "add" | "remove" | "context" | "header";
  readonly content: string;
}

interface NeolixDiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: ReadonlyArray<NeolixDiffLine>;
}

interface NeolixDiffFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: ReadonlyArray<NeolixDiffHunk>;
  readonly status?: "ok" | "too_large" | "binary";
}

export interface NeolixDiffPayload {
  readonly files: ReadonlyArray<NeolixDiffFile>;
  readonly error: { readonly message: string; readonly code?: string } | null;
  readonly diffTooLarge?: boolean;
}

interface NeolixBranchSuggestion {
  readonly name: string;
  readonly hasLocal?: boolean;
}

interface NeolixBranchSuggestions {
  readonly branches: ReadonlyArray<string>;
  readonly branchDetails?: ReadonlyArray<NeolixBranchSuggestion>;
  readonly error: string | null;
}

interface NeolixCommitFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: "added" | "modified" | "deleted" | "renamed";
}

interface NeolixCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorDate: string;
  readonly isOnRemote?: boolean;
  readonly isOnBase?: boolean;
  readonly files?: ReadonlyArray<NeolixCommitFile>;
}

interface NeolixWorktree {
  readonly worktreePath: string;
  readonly branchName?: string | null;
}

interface NeolixCommandPayload {
  readonly success?: boolean;
  readonly error: { readonly message: string } | null;
}

interface NeolixSwitchBranchPayload extends NeolixCommandPayload {
  readonly branch: string;
}

interface NeolixStashEntry {
  readonly index: number;
  readonly message: string;
  readonly branch: string | null;
  readonly isNeolix: boolean;
}

interface NeolixStashListPayload {
  readonly entries: ReadonlyArray<NeolixStashEntry>;
  readonly error: { readonly message: string } | null;
}

interface NeolixPrCreatePayload {
  readonly url: string | null;
  readonly number: number | null;
  readonly error: { readonly message: string } | null;
}

interface NeolixCreatedWorkspace {
  readonly workspace: {
    readonly workspaceDirectory?: string;
    readonly projectRootPath: string;
    readonly gitRuntime?: { readonly currentBranch?: string | null } | null;
  } | null;
  readonly error: string | null;
}

type DiffScope = "workingTree" | "unstaged" | "staged" | "branch" | "ref";

const nonNegative = (value: number | null | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;

/**
 * Neox names the tracked upstream with its full ref; Synara shows the branch name, e.g.
 * `refs/remotes/origin/main` → `main`.
 */
function upstreamBranchName(ref: string | null | undefined): string | null {
  const normalized = ref?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.startsWith("refs/remotes/")) {
    const withoutPrefix = normalized.slice("refs/remotes/".length);
    const slash = withoutPrefix.indexOf("/");
    return (slash === -1 ? withoutPrefix : withoutPrefix.slice(slash + 1)).trim() || null;
  }
  if (normalized.startsWith("refs/heads/")) {
    return normalized.slice("refs/heads/".length).trim() || null;
  }
  return normalized;
}

/**
 * The one diff shape Neox can answer. `all` compares the base ref's merge base against the
 * working tree (untracked included), matching Synara's `branch`/`ref` scopes; `uncommitted`
 * compares HEAD against the working tree, matching `workingTree`. `staged` and `unstaged` have
 * no Neox equivalent: staging happens in an index the daemon does not project separately, so
 * `staged` reports an empty diff instead of pretending the combined diff is index-only.
 */
function compareForScope(
  scope: DiffScope,
  compareRef: string | undefined,
): { mode: "uncommitted" | "all"; baseRef?: string } | null {
  switch (scope) {
    case "staged":
      return null;
    case "branch":
      return { mode: "all" };
    case "ref": {
      const baseRef = compareRef?.trim() ?? "";
      return baseRef ? { mode: "all", baseRef } : null;
    }
    case "unstaged":
    case "workingTree":
    default:
      return { mode: "uncommitted" };
  }
}

/** The daemon's `NOT_GIT_REPO` diff failure, kept distinct so callers can treat it as "no diff". */
class NotGitRepositoryError extends Error {}

async function readDiff(
  client: DaemonClient,
  cwd: string,
  scope: DiffScope,
  compareRef?: string,
): Promise<NeolixDiffPayload> {
  const compare = compareForScope(scope, compareRef);
  if (!compare) return { files: [], error: null };
  const payload = (await client.getCheckoutDiff(cwd, compare)) as unknown as NeolixDiffPayload;
  if (payload.error?.code === "NOT_GIT_REPO")
    throw new NotGitRepositoryError(payload.error.message);
  if (payload.error) {
    throw bridgeError("git.diff-failed", payload.error.message, { detail: payload.error.message });
  }
  return payload;
}

/** A checkout mutation Neox answers with `{ success, error }` instead of throwing. */
function assertCommandSucceeded(
  payload: NeolixCommandPayload,
  fallback: string,
  token: string,
): void {
  if (payload.error) {
    throw bridgeError(token, payload.error.message, { detail: payload.error.message });
  }
  if (payload.success === false) throw bridgeError(token, fallback);
}

/**
 * A stream RPC over one async Neox operation. Each emitted event reaches the front end as it
 * happens; the operation's failure ends the stream with a `WsRpcError` after the handler has
 * already published an `action_failed` event carrying the phase and message.
 */
function operationStream<T>(
  run: (emit: (event: T) => void) => Promise<void>,
): Stream.Stream<T, WsRpcError> {
  return Stream.callback<T, WsRpcError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        void run((event) => Queue.offerUnsafe(queue, event))
          .then(() => Queue.endUnsafe(queue))
          .catch((cause: unknown) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(cause instanceof WsRpcError ? cause : rpcError(cause)),
            ),
          );
      }),
      () => Effect.void,
    ),
  );
}

/** A stream RPC over one git action, surfaced to the front end as its progress events. */
function progressStream(
  run: (emit: (event: GitActionProgressEvent) => void) => Promise<void>,
): Stream.Stream<GitActionProgressEvent, WsRpcError> {
  return operationStream(run);
}

/** A unified patch from Neox's parsed hunks, so the front end's diff viewer can render it. */
export function renderUnifiedPatch(
  files: ReadonlyArray<NeolixDiffFile>,
  filePath?: string,
): string {
  const wanted = filePath?.trim();
  const selected = wanted
    ? files.filter((file) => file.path === wanted || file.oldPath === wanted)
    : files;
  return selected
    .filter((file) => file.status !== "binary" && file.status !== "too_large")
    .map((file) => {
      const oldPath = file.oldPath ?? file.path;
      const lines = [`diff --git a/${oldPath} b/${file.path}`];
      if (file.isNew) lines.push("--- /dev/null");
      else lines.push(`--- a/${oldPath}`);
      if (file.isDeleted) lines.push("+++ /dev/null");
      else lines.push(`+++ b/${file.path}`);
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === "header") lines.push(line.content);
          else if (line.type === "add") lines.push(`+${line.content}`);
          else if (line.type === "remove") lines.push(`-${line.content}`);
          else lines.push(` ${line.content}`);
        }
      }
      return `${lines.join("\n")}\n`;
    })
    .join("");
}

/**
 * `renderUnifiedPatch` drops binary and oversized files because there is no text to show.
 * A commit whose only change is a binary asset would then look empty, so keep a parseable
 * header (the diff viewer renders it as a file row) instead.
 */
function renderBinaryCommitFilePatch(file: NeolixCommitFile): string {
  const oldSide = file.status === "added" ? "/dev/null" : `a/${file.path}`;
  const newSide = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
  return `${[
    `diff --git a/${file.path} b/${file.path}`,
    `Binary files ${oldSide} and ${newSide} differ`,
  ].join("\n")}\n`;
}

function toGitCommit(commit: NeolixCommit): GitCommit {
  return {
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    authorName: commit.authorName ?? "",
    authorDate: commit.authorDate,
    isOnRemote: commit.isOnRemote === true,
    isOnBase: commit.isOnBase,
    files: (commit.files ?? []).map((file) => ({
      path: file.path.trim(),
      additions: nonNegative(file.additions),
      deletions: nonNegative(file.deletions),
      status: file.status,
    })),
  };
}

function diffStats(files: ReadonlyArray<NeolixDiffFile>): GitWorkingTreeDiffStatsResult {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += nonNegative(file.additions);
    deletions += nonNegative(file.deletions);
  }
  return { additions, deletions, fileCount: files.length };
}

function workingTreeFiles(
  files: ReadonlyArray<NeolixDiffFile>,
): GitStatusResult["workingTree"]["files"] {
  return files
    .map((file) => ({
      path: file.path.trim(),
      insertions: nonNegative(file.additions),
      deletions: nonNegative(file.deletions),
    }))
    .filter((file) => file.path.length > 0);
}

async function readStatus(client: DaemonClient, cwd: string): Promise<NeolixCheckoutStatus> {
  const status = (await client.getCheckoutStatus(cwd)) as unknown as NeolixCheckoutStatus;
  if (status.error) {
    throw bridgeError("git.status-failed", status.error.message, { detail: status.error.message });
  }
  return status;
}

const execFileAsync = promisify(execFile);

/**
 * The daemon answers `git.status` from a cached workspace snapshot that only a
 * file watcher or an explicit refresh updates; a bridge that only polls status
 * can therefore be told "clean" long after the working tree changed. Its diff
 * read is the only fresh view. Run `git status --porcelain` here as the
 * authority instead: it is cheap, local, and matches what `git commit` sees.
 *
 * Returns null when the folder is not a checkout or git is unavailable, in
 * which case the daemon's status stays the answer.
 */
export async function readPorcelainDirty(cwd: string): Promise<boolean | null> {
  if (!path.isAbsolute(cwd)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

const PR_STATUS_TTL_MS = 10_000;
const prStatusCache = new Map<string, { at: number; pr: GitStatusResult["pr"] }>();

/**
 * The branch's pull request, when the forge answers. A missing gh/forge login is not a git
 * failure: the status stays useful and the PR row simply stays hidden. Git status is polled
 * while an agent works, so the forge read is cached briefly instead of spawning gh every tick.
 */
async function readPr(client: DaemonClient, cwd: string): Promise<GitStatusResult["pr"]> {
  const cached = prStatusCache.get(cwd);
  if (cached && Date.now() - cached.at < PR_STATUS_TTL_MS) return cached.pr;
  let pr: GitStatusResult["pr"] = null;
  try {
    const payload = (await client.checkoutPrStatus(cwd)) as unknown as NeolixPrStatusPayload;
    if (!payload.error && payload.status) {
      const mapped = toGitStatusPr(payload.status);
      pr = mapped.number > 0 ? mapped : null;
    }
  } catch {
    pr = null;
  }
  prStatusCache.set(cwd, { at: Date.now(), pr });
  return pr;
}

/** A mutation can change the branch's PR; the next status poll reads the forge again. */
function invalidatePrStatus(cwd: string): void {
  prStatusCache.delete(cwd);
}

/** The raw forge status, for filling in the fields a PR-create response omits. */
async function readPrStatus(
  client: DaemonClient,
  cwd: string,
): Promise<NeolixPrStatusPayload["status"]> {
  try {
    const payload = (await client.checkoutPrStatus(cwd)) as unknown as NeolixPrStatusPayload;
    if (!payload.error && payload.status) return payload.status;
  } catch {
    // A missing forge login is not a failed git action; the caller falls back to what it knows.
  }
  return null;
}

function prNumber(status: { readonly number?: number; readonly url: string }): number | null {
  if (typeof status.number === "number" && Number.isFinite(status.number) && status.number > 0) {
    return Math.trunc(status.number);
  }
  const match = /\/pull\/(\d+)\b/.exec(status.url);
  return match?.[1] ? Number(match[1]) : null;
}

async function readBranches(
  client: DaemonClient,
  cwd: string,
  status: NeolixCheckoutStatus,
): Promise<GitListBranchesResult> {
  if (!status.isGit) return { branches: [], isRepo: false, hasOriginRemote: false };
  const suggestions = (await client.getBranchSuggestions({
    cwd,
    limit: 200,
  })) as unknown as NeolixBranchSuggestions;
  if (suggestions.error) {
    throw bridgeError("git.branch-suggestions-failed", suggestions.error, {
      detail: suggestions.error,
    });
  }
  const meta = new Map((suggestions.branchDetails ?? []).map((entry) => [entry.name, entry]));

  // Worktrees are the only place Neox exposes a per-branch checkout path.
  const worktrees = new Map<string, string>();
  try {
    const list = (await client.getNeolixWorktreeList({ cwd })) as unknown as {
      worktrees?: ReadonlyArray<NeolixWorktree>;
    };
    for (const worktree of list.worktrees ?? []) {
      const branch = worktree.branchName?.trim();
      if (branch) worktrees.set(branch, worktree.worktreePath);
    }
  } catch {
    // A repository without the worktree registry still lists its branches.
  }

  const current = status.currentBranch?.trim() ?? null;
  const defaultBranch = status.baseRef?.trim() ?? null;
  const branches = suggestions.branches
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const hasLocal = meta.get(name)?.hasLocal !== false;
      return {
        name,
        ...(hasLocal ? {} : { isRemote: true, remoteName: "origin" }),
        current: name === current,
        isDefault: name === defaultBranch,
        worktreePath: worktrees.get(name) ?? null,
      };
    });

  return { branches, isRepo: true, hasOriginRemote: status.hasRemote };
}

function githubRepository(remoteUrl: string | null): GitHubRepositoryResult {
  const repository = parseGithubRepository(remoteUrl);
  return {
    repository,
    repositories: repository ? [repository] : [],
  };
}

function parseGithubRepository(
  remoteUrl: string | null,
): { nameWithOwner: string; url: string } | null {
  const raw = remoteUrl?.trim() ?? "";
  if (!raw) return null;
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      raw,
    );
  if (!match?.[1] || !match[2]) return null;
  const nameWithOwner = `${match[1]}/${match[2]}`;
  return { nameWithOwner, url: `https://github.com/${nameWithOwner}` };
}

async function pullBranch(client: DaemonClient, cwd: string): Promise<GitPullResult> {
  const before = await readStatus(client, cwd);
  if (!before.isGit) throw bridgeError("git.not-a-repository", "Not a git repository.");
  const branch = before.currentBranch?.trim() ?? "";
  if (!branch) throw bridgeError("git.detached-head", "Cannot pull from detached HEAD.");
  const upstream = upstreamBranchName(before.upstreamRef);
  if (!upstream) {
    throw bridgeError("git.no-upstream", "No upstream branch is configured.");
  }
  // Always pull: `behindOfOrigin` comes from the daemon's last fetch, so a stale count must not
  // skip the fetch that would discover new remote commits. Neox reports only success/failure,
  // not whether the pull was a no-op.
  const payload = (await client.checkoutPull(cwd)) as unknown as NeolixCommandPayload;
  assertCommandSucceeded(payload, "git pull failed", "git.pull-failed");
  const after = await readStatus(client, cwd);
  return {
    status: "pulled",
    branch: after.currentBranch?.trim() || branch,
    upstreamBranch: upstreamBranchName(after.upstreamRef) ?? upstream,
  };
}

async function checkoutBranch(client: DaemonClient, cwd: string, branch: string): Promise<void> {
  try {
    const payload = (await client.checkoutSwitchBranch(
      cwd,
      branch,
    )) as unknown as NeolixSwitchBranchPayload;
    assertCommandSucceeded(payload, `Could not check out ${branch}.`, "git.checkout-failed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/uncommitted changes|working directory has uncommitted/i.test(message)) throw error;
    // The fork's recovery toast parses Synara's exact dirty-checkout shape to offer
    // "Stash & Switch"; Neox's own message carries no file list, so build it from the diff.
    const files = (await readDiff(client, cwd, "workingTree")).files
      .filter((file) => file.status !== "binary" && file.status !== "too_large")
      .map((file) => file.path.trim())
      .filter((path) => path.length > 0);
    throw bridgeError(
      "git.checkout-blocked-by-changes",
      `Uncommitted changes block checkout to ${branch}:\n${
        files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- working tree"
      }`,
      { branch, files: files.length > 0 ? files.join(", ") : "working tree" },
    );
  }
}

/**
 * Neox has one stash route pair (save by branch tag, pop by index), so "stash and checkout"
 * saves the dirty tree tagged with the branch it came from and then switches. The stash is left
 * in place instead of being reapplied, matching the old UI: the branch switcher offers to
 * restore it when the user comes back.
 */
async function stashAndCheckout(client: DaemonClient, cwd: string, branch: string): Promise<void> {
  const status = await readStatus(client, cwd);
  const sourceBranch = status.currentBranch?.trim();
  const saved = (await client.stashSave(
    cwd,
    sourceBranch ? { branch: sourceBranch } : undefined,
  )) as unknown as NeolixCommandPayload;
  assertCommandSucceeded(saved, "git stash failed", "git.stash-save-failed");
  await checkoutBranch(client, cwd, branch);
}

async function stashInfo(client: DaemonClient, cwd: string): Promise<GitStashInfoResult> {
  const list = (await client.stashList(cwd, {
    neolixOnly: true,
  })) as unknown as NeolixStashListPayload;
  if (list.error) {
    throw bridgeError("git.stash-list-failed", list.error.message, { detail: list.error.message });
  }
  const entry = list.entries[0];
  if (!entry) throw bridgeError("git.no-stash-entry", "No stash entry is available.");
  let branch: string | null = null;
  try {
    branch = (await readStatus(client, cwd)).currentBranch?.trim() || null;
  } catch {
    // The stash itself is the answer; a status read failure must not hide it.
  }
  return {
    cwd,
    branch,
    stashRef: `stash@{${Math.max(0, Math.trunc(entry.index))}}`,
    message: entry.message.trim() || "Stashed changes",
    files: [],
  };
}

/**
 * Neox tags stashes with the branch they came from and can list them, so the branch
 * switcher can offer "restore" when the user comes back. `neolixOnly` keeps stashes the
 * user made by hand in git out of that prompt.
 */
async function listStashes(
  client: DaemonClient,
  cwd: string,
): Promise<{ entries: ReadonlyArray<{ index: number; message: string; branch: string | null }> }> {
  const list = (await client.stashList(cwd, {
    neolixOnly: true,
  })) as unknown as NeolixStashListPayload;
  if (list.error) {
    throw bridgeError("git.stash-list-failed", list.error.message, { detail: list.error.message });
  }
  return {
    entries: list.entries.map((entry) => ({
      index: Math.max(0, Math.trunc(entry.index)),
      message: entry.message.trim(),
      branch: entry.branch?.trim() || null,
    })),
  };
}

/** `stash@{N}` is the only form the branch switcher produces; reject anything else. */
function parseStashIndex(stashRef: string): number {
  const match = /^stash@\{(\d+)\}$/.exec(stashRef.trim());
  if (!match?.[1]) {
    throw bridgeError("git.invalid-stash-ref", `"${stashRef}" is not a stash reference.`, {
      ref: stashRef,
    });
  }
  return Number(match[1]);
}

async function popStash(client: DaemonClient, cwd: string, stashRef: string): Promise<void> {
  const stashIndex = parseStashIndex(stashRef);
  const payload = (await client.stashPop(cwd, stashIndex)) as unknown as NeolixCommandPayload;
  assertCommandSucceeded(payload, "git stash pop failed", "git.stash-pop-failed");
}

interface CreatedWorktreeCheckout {
  readonly path: string;
  readonly branch: string | null;
}

/**
 * A worktree checkout backed by a Neox workspace. `branchName` pins the checkout to the
 * caller's branch; without it the ref is checked out as-is. Neox picks the directory.
 */
async function createWorktreeCheckout(
  client: DaemonClient,
  input: {
    readonly cwd: string;
    readonly ref: string;
    readonly newBranch?: string;
    /** Joins the worktree to the source project; without it the daemon mints a new project. */
    readonly projectId?: string;
  },
): Promise<CreatedWorktreeCheckout> {
  const newBranch = input.newBranch?.trim() || null;
  const created = (await client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: input.cwd,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      action: newBranch ? "branch-off" : "checkout",
      refName: input.ref,
      ...(newBranch ? { branchName: newBranch } : {}),
    },
  })) as unknown as NeolixCreatedWorkspace;
  if (created.error) {
    throw bridgeError("git.worktree-create-failed", created.error, { detail: created.error });
  }
  const workspace = created.workspace;
  const path = workspace?.workspaceDirectory ?? workspace?.projectRootPath;
  if (!path) {
    throw bridgeError("git.worktree-no-directory", "The worktree was created without a directory.");
  }
  return {
    path,
    branch: workspace?.gitRuntime?.currentBranch?.trim() || newBranch,
  };
}

/**
 * Synara's detached-worktree stream. Neox creates the checkout in a single workspace call, so
 * the stream reports the branch and worktree phases around it; there is no `copy-changes` phase
 * because the daemon has no route that moves uncommitted changes into a new worktree.
 */
function createDetachedWorktreeStream(
  client: DaemonClient,
  input: GitCreateDetachedWorktreeInput,
  projectId: string | undefined,
  onCreated: (checkout: CreatedWorktreeCheckout) => void,
): Stream.Stream<GitWorktreeSetupProgressEvent, WsRpcError> {
  if (input.path?.trim()) {
    return Stream.fail(
      codedError(
        "git.worktree-custom-path",
        "Neox chooses the worktree directory; a custom path is not supported.",
        undefined,
        { retryable: false },
      ),
    );
  }
  const progressId = input.progressId?.trim() || null;
  return operationStream<GitWorktreeSetupProgressEvent>(async (emit) => {
    emit({ progressId, kind: "phase_started", phase: "branch" });
    emit({ progressId, kind: "phase_started", phase: "worktree" });
    const created = await createWorktreeCheckout(client, {
      cwd: input.cwd,
      ref: input.ref,
      ...(projectId ? { projectId } : {}),
      ...(input.newBranch ? { newBranch: input.newBranch } : {}),
    });
    onCreated(created);
    emit({
      progressId,
      kind: "completed",
      result: {
        worktree: { path: created.path, ref: input.ref, branch: created.branch },
      },
    });
  });
}

async function createWorktree(
  client: DaemonClient,
  input: GitCreateWorktreeInput,
  projectId: string | undefined,
): Promise<GitCreateWorktreeResult> {
  if (input.path?.trim()) {
    throw bridgeError(
      "git.worktree-custom-path",
      "Neox chooses the worktree directory; a custom path is not supported.",
    );
  }
  const created = await createWorktreeCheckout(client, {
    cwd: input.cwd,
    ref: input.branch,
    ...(projectId ? { projectId } : {}),
    ...(input.newBranch ? { newBranch: input.newBranch } : {}),
  });
  return {
    worktree: { path: created.path, branch: created.branch ?? input.newBranch ?? input.branch },
  };
}

const PHASE_LABELS: Record<GitActionProgressPhase, string> = {
  branch: "Preparing feature branch...",
  commit: "Committing...",
  push: "Pushing...",
  pr: "Creating PR...",
};

/**
 * Synara's branch → commit → push → PR chain, mapped onto Neox's checkout routes. Neox cannot
 * create a branch in place, so a requested feature branch fails in its own phase instead of
 * silently committing on the default branch.
 */
async function runStackedAction(
  client: DaemonClient,
  input: GitRunStackedActionInput,
  emit: (event: GitActionProgressEvent) => void,
  porcelainDirty: (cwd: string) => Promise<boolean | null> = readPorcelainDirty,
): Promise<void> {
  const { actionId, cwd, action } = input;
  const base = { actionId, cwd, action };
  let phase: GitActionProgressPhase | null = null;
  const startPhase = (next: GitActionProgressPhase) => {
    phase = next;
    emit({ ...base, kind: "phase_started", phase: next, label: PHASE_LABELS[next] });
  };
  // `checkout_status_request` serves the daemon's cached snapshot, which can say
  // "clean" long after the working tree changed. Ask git directly before a phase
  // decides there is nothing to commit or push.
  const workingTreeIsDirty = async (status: NeolixCheckoutStatus): Promise<boolean> =>
    status.isDirty === true || (await porcelainDirty(cwd)) === true;

  const wantsCommit =
    action === "commit" || action === "commit_push" || action === "commit_push_pr";
  const wantsPr = action === "create_pr" || action === "commit_push_pr";

  try {
    const initial = await readStatus(client, cwd);
    if (!initial.isGit) throw bridgeError("git.not-a-repository", "Not a git repository.");
    const wantsPush =
      action === "push" ||
      action === "commit_push" ||
      action === "commit_push_pr" ||
      (action === "create_pr" &&
        (upstreamBranchName(initial.upstreamRef) === null ||
          nonNegative(initial.aheadOfOrigin) > 0));
    // Phases follow the status read: `create_pr` only pushes when the branch has local work or
    // no upstream yet, and the progress UI should name exactly the phases that will run.
    emit({
      ...base,
      kind: "action_started",
      phases: [
        ...(input.featureBranch ? (["branch"] as const) : []),
        ...(wantsCommit ? (["commit"] as const) : []),
        ...(wantsPush ? (["push"] as const) : []),
        ...(wantsPr ? (["pr"] as const) : []),
      ],
    });
    if (input.featureBranch) {
      throw notSupported("git.runStackedAction featureBranch");
    }
    if ((wantsPush || wantsPr) && !initial.currentBranch?.trim()) {
      throw bridgeError(
        "git.detached-head",
        "Cannot push or create a pull request from detached HEAD.",
      );
    }
    if (
      (action === "push" || action === "create_pr") &&
      (await workingTreeIsDirty(initial)) &&
      !input.allowDirtyWorkingTree
    ) {
      throw bridgeError(
        action === "push" ? "git.dirty-before-push" : "git.dirty-before-pr",
        action === "push"
          ? "Commit or stash local changes before pushing."
          : "Commit local changes before creating a PR.",
      );
    }

    let commit: GitRunStackedActionResult["commit"] = { status: "skipped_not_requested" };
    if (wantsCommit) {
      startPhase("commit");
      if (input.filePaths && input.filePaths.length > 0) {
        throw bridgeError(
          "git.selective-commits-unsupported",
          "Neox commits the whole working tree; selective commits are not supported.",
        );
      }
      if (!(await workingTreeIsDirty(initial))) {
        commit = { status: "skipped_no_changes" };
      } else {
        const message = input.commitMessage?.trim() || (wantsPr ? input.prTitle?.trim() : "");
        const payload = (await client.checkoutCommit(cwd, {
          addAll: true,
          ...(message ? { message } : {}),
        })) as unknown as NeolixCommandPayload;
        assertCommandSucceeded(payload, "git commit failed", "git.commit-failed");
        let latest: NeolixCommit | undefined;
        try {
          latest = (
            (await client.listCheckoutCommits(cwd)) as unknown as {
              commits: ReadonlyArray<NeolixCommit>;
            }
          ).commits[0];
        } catch {
          // The commit is the outcome; a history read failure must not report it as lost.
        }
        commit = {
          status: "created",
          ...(latest ? { commitSha: latest.sha, subject: latest.subject } : {}),
        };
      }
    }

    let push: GitRunStackedActionResult["push"] = { status: "skipped_not_requested" };
    if (wantsPush) {
      startPhase("push");
      const before = await readStatus(client, cwd);
      if (
        upstreamBranchName(before.upstreamRef) !== null &&
        nonNegative(before.aheadOfOrigin) === 0 &&
        nonNegative(before.behindOfOrigin) === 0
      ) {
        const branch = before.currentBranch?.trim();
        const upstream = upstreamBranchName(before.upstreamRef);
        push = {
          status: "skipped_up_to_date",
          ...(branch ? { branch } : {}),
          ...(upstream ? { upstreamBranch: upstream } : {}),
        };
      } else {
        const payload = (await client.checkoutPush(cwd)) as unknown as NeolixCommandPayload;
        assertCommandSucceeded(payload, "git push failed", "git.push-failed");
        invalidatePrStatus(cwd);
        let after: NeolixCheckoutStatus | null = null;
        try {
          after = await readStatus(client, cwd);
        } catch {
          // Push already succeeded; keep the pre-push branch identity below.
        }
        const branch = after?.currentBranch?.trim() || before.currentBranch?.trim() || undefined;
        const upstream = upstreamBranchName(after?.upstreamRef ?? before.upstreamRef) ?? undefined;
        push = {
          status: "pushed",
          ...(branch ? { branch } : {}),
          ...(upstream ? { upstreamBranch: upstream } : {}),
          setUpstream: upstreamBranchName(before.upstreamRef) === null,
        };
      }
    }

    let pr: GitRunStackedActionResult["pr"] = { status: "skipped_not_requested" };
    if (wantsPr) {
      startPhase("pr");
      if (input.prDraft === true) {
        throw bridgeError(
          "git.draft-pr-unsupported",
          "Draft pull requests are not supported by the Neox daemon.",
        );
      }
      const created = (await client.checkoutPrCreate(cwd, {
        ...(input.prTitle ? { title: input.prTitle } : {}),
        ...(input.prBody ? { body: input.prBody } : {}),
      })) as unknown as NeolixPrCreatePayload;
      invalidatePrStatus(cwd);
      const status = await readPrStatus(client, cwd);
      const currentBranch = (
        await readStatus(client, cwd).catch(() => null)
      )?.currentBranch?.trim();
      if (created.error) {
        const alreadyExists = /already exists|already has a pull request/i.test(
          created.error.message,
        );
        const belongsToCurrentBranch =
          alreadyExists &&
          status?.state === "open" &&
          (!currentBranch || status.headRefName.trim() === currentBranch);
        if (!belongsToCurrentBranch) {
          throw bridgeError("git.pr-create-failed", created.error.message, {
            detail: created.error.message,
          });
        }
        pr = {
          status: "opened_existing",
          url: status.url,
          ...(prNumber(status) ? { number: prNumber(status)! } : {}),
          baseBranch: status.baseRefName,
          headBranch: status.headRefName,
          title: status.title,
        };
      } else {
        const url = created.url ?? status?.url ?? null;
        if (!url) {
          throw bridgeError("git.pr-no-url", "The pull request was created without a URL.");
        }
        const number = created.number ?? (status ? prNumber(status) : null);
        const baseBranch = status?.baseRefName ?? initial.baseRef?.trim() ?? undefined;
        const headBranch =
          status?.headRefName ?? currentBranch ?? initial.currentBranch?.trim() ?? undefined;
        const title = status?.title ?? input.prTitle?.trim() ?? undefined;
        pr = {
          status: "created",
          url,
          ...(number && number > 0 ? { number } : {}),
          ...(baseBranch ? { baseBranch } : {}),
          ...(headBranch ? { headBranch } : {}),
          ...(title ? { title } : {}),
        };
      }
    }

    const result: GitRunStackedActionResult = {
      action,
      branch: { status: "skipped_not_requested" },
      commit,
      push,
      pr,
    };
    emit({ ...base, kind: "action_finished", result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ ...base, kind: "action_failed", phase, message });
    throw error;
  }
}

export function makeGitHandlers(
  model: BridgeModel,
  options: { readonly readPorcelainDirty?: (cwd: string) => Promise<boolean | null> } = {},
): Record<string, AnyHandler> {
  const client = model.client;
  const porcelainDirty = options.readPorcelainDirty ?? readPorcelainDirty;
  return {
    [WS_METHODS.gitStatus]: (payload) =>
      fromPromise("git.status", async () => {
        const { cwd } = payload as { cwd: string };
        const status = await readStatus(client, cwd);
        if (!status.isGit) {
          return {
            branch: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: false,
            upstreamBranch: null,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          } satisfies GitStatusResult;
        }
        // The cached status can lag the tree, so a clean report is confirmed by
        // `git status --porcelain` before the diff is skipped. A dirty report needs
        // the diff either way to fill the file list.
        const isDirty = status.isDirty === true ? true : ((await porcelainDirty(cwd)) ?? false);
        const diff = isDirty
          ? await readDiff(client, cwd, "workingTree")
          : { files: [], error: null };
        const files = workingTreeFiles(diff.files);
        const insertions = files.reduce((total, file) => total + file.insertions, 0);
        const deletions = files.reduce((total, file) => total + file.deletions, 0);
        const upstreamBranch = upstreamBranchName(status.upstreamRef);
        const pr = await readPr(client, cwd);
        // The shell's `lastKnownPr` comes from this cache, so a status poll also refreshes
        // the sidebar badge without a second forge read.
        model.notePrStatus(cwd, pr);
        return {
          branch: status.currentBranch?.trim() || null,
          hasWorkingTreeChanges: isDirty,
          workingTree: { files, insertions, deletions },
          hasUpstream: upstreamBranch !== null,
          upstreamBranch,
          aheadCount: nonNegative(status.aheadOfOrigin),
          behindCount: nonNegative(status.behindOfOrigin),
          pr,
        } satisfies GitStatusResult;
      }),

    [WS_METHODS.gitListBranches]: (payload) =>
      fromPromise("git.listBranches", async () => {
        const { cwd } = payload as { cwd: string };
        const status = await readStatus(client, cwd);
        return readBranches(client, cwd, status);
      }),

    [WS_METHODS.gitWorkingTreeDiffStats]: (payload) =>
      fromPromise("git.workingTreeDiffStats", async () => {
        const input = payload as {
          cwd: string;
          scope?: DiffScope;
          compareRef?: string;
          filePath?: string;
        };
        if (input.filePath) {
          throw bridgeError(
            "git.file-scoped-stats-unsupported",
            "File-scoped diff statistics are not supported.",
          );
        }
        const scope = input.scope ?? "workingTree";
        if (scope === "ref" && !input.compareRef?.trim()) {
          throw bridgeError(
            "git.compare-ref-required",
            "A branch or commit is required to compare the working tree against.",
          );
        }
        const diff = await readDiff(client, input.cwd, scope, input.compareRef).catch(
          (error: unknown) => {
            // A plain folder (the Home chat container) has no changes to count.
            if (error instanceof NotGitRepositoryError) return { files: [], error: null };
            throw error;
          },
        );
        return diffStats(diff.files);
      }),

    [WS_METHODS.gitReadWorkingTreeDiff]: (payload) =>
      fromPromise("git.readWorkingTreeDiff", async () => {
        const input = payload as {
          cwd: string;
          scope?: DiffScope;
          compareRef?: string;
          filePath?: string;
        };
        const scope = input.scope ?? "workingTree";
        const filePath = input.filePath?.trim();
        if (filePath && scope !== "workingTree") {
          throw bridgeError(
            "git.file-scoped-diff-unsupported",
            "File-scoped diffs are only supported for the working tree scope.",
          );
        }
        if (scope === "ref" && !input.compareRef?.trim()) {
          throw bridgeError(
            "git.compare-ref-required",
            "A branch or commit is required to compare the working tree against.",
          );
        }
        const diff = await readDiff(client, input.cwd, scope, input.compareRef);
        return {
          patch: renderUnifiedPatch(diff.files, filePath),
          truncated: diff.diffTooLarge === true,
        } satisfies GitReadWorkingTreeDiffResult;
      }),

    [WS_METHODS.gitListRecentCommits]: (payload) =>
      fromPromise("git.listRecentCommits", async () => {
        const input = payload as { cwd: string; limit?: number };
        const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
        const { commits } = (await client.listCheckoutCommits(input.cwd)) as unknown as {
          commits: ReadonlyArray<NeolixCommit>;
        };
        return {
          commits: commits.slice(0, limit).map((commit) => ({
            sha: commit.sha,
            shortSha: commit.shortSha,
            subject: commit.subject,
            committedAt: commit.authorDate,
          })),
        } satisfies GitListRecentCommitsResult;
      }),

    [WS_METHODS.gitListCommits]: (payload) =>
      fromPromise("git.listCommits", async () => {
        const { cwd } = payload as { cwd: string };
        const { baseRef, commits } = (await client.listCheckoutCommits(cwd)) as unknown as {
          baseRef: string | null;
          commits: ReadonlyArray<NeolixCommit>;
        };
        return {
          baseRef,
          commits: commits.map(toGitCommit),
        } satisfies GitListCommitsResult;
      }),

    [WS_METHODS.gitCommitDiff]: (payload) =>
      fromPromise("git.commitDiff", async () => {
        const { cwd, sha } = payload as { cwd: string; sha: string };
        const { commits } = (await client.listCheckoutCommits(cwd)) as unknown as {
          commits: ReadonlyArray<NeolixCommit>;
        };
        const commit = commits.find((candidate) => candidate.sha === sha);
        if (!commit) {
          throw bridgeError(
            "git.commit-not-found",
            `Commit ${sha} was not found in the checkout.`,
            {
              sha,
            },
          );
        }
        const commitFiles = commit.files ?? [];
        const resolved = await Promise.all(
          commitFiles.map(async (file) => {
            const result = await client.getCommitFileDiff(cwd, sha, file.path);
            return result.file;
          }),
        );
        const patch = commitFiles
          .map((file, index) => {
            const resolvedFile = resolved[index] as unknown as NeolixDiffFile | null;
            if (
              resolvedFile &&
              resolvedFile.status !== "binary" &&
              resolvedFile.status !== "too_large"
            ) {
              return renderUnifiedPatch([resolvedFile]);
            }
            return renderBinaryCommitFilePatch(file);
          })
          .join("");
        return {
          patch,
          truncated: false,
        } satisfies GitCommitDiffResult;
      }),

    [WS_METHODS.gitGithubRepository]: (payload) =>
      fromPromise("git.githubRepository", async () => {
        const { cwd } = payload as { cwd: string };
        const status = await readStatus(client, cwd);
        return githubRepository(status.remoteUrl);
      }),

    [WS_METHODS.gitPull]: (payload) =>
      fromPromise("git.pull", () => pullBranch(client, (payload as { cwd: string }).cwd)),

    [WS_METHODS.gitRunStackedAction]: (payload) => {
      const input = payload as GitRunStackedActionInput;
      return progressStream((emit) => runStackedAction(client, input, emit, porcelainDirty));
    },

    [WS_METHODS.gitCheckout]: (payload) =>
      fromPromise("git.checkout", async () => {
        const input = payload as { cwd: string; branch: string };
        await checkoutBranch(client, input.cwd, input.branch);
      }),

    [WS_METHODS.gitStashAndCheckout]: (payload) =>
      fromPromise("git.stashAndCheckout", async () => {
        const input = payload as { cwd: string; branch: string };
        await stashAndCheckout(client, input.cwd, input.branch);
      }),

    [WS_METHODS.gitStashInfo]: (payload) =>
      fromPromise("git.stashInfo", () => stashInfo(client, (payload as { cwd: string }).cwd)),

    [WS_METHODS.gitStashList]: (payload) =>
      fromPromise("git.stashList", () => listStashes(client, (payload as { cwd: string }).cwd)),

    [WS_METHODS.gitStashPop]: (payload) =>
      fromPromise("git.stashPop", () => {
        const input = payload as { cwd: string; stashRef: string };
        return popStash(client, input.cwd, input.stashRef);
      }),

    [WS_METHODS.gitCreateWorktree]: (payload) =>
      fromPromise("git.createWorktree", async () => {
        const input = payload as GitCreateWorktreeInput;
        const result = await createWorktree(client, input, model.projectIdForCwd(input.cwd));
        model.rememberWorktree(result.worktree.path, result.worktree.branch);
        return result;
      }),

    [WS_METHODS.gitCreateDetachedWorktree]: (payload) => {
      const input = payload as GitCreateDetachedWorktreeInput;
      return createDetachedWorktreeStream(
        client,
        input,
        model.projectIdForCwd(input.cwd),
        (checkout) => model.rememberWorktree(checkout.path, checkout.branch),
      );
    },

    [WS_METHODS.gitDiscardChanges]: (payload) =>
      fromPromise("git.discardChanges", async () => {
        const input = payload as GitDiscardChangesInput;
        const result = (await client.checkoutDiscardChanges(input.cwd, {
          paths: [...input.paths],
        })) as unknown as NeolixCommandPayload;
        assertCommandSucceeded(result, "git discard failed", "git.discard-failed");
        invalidatePrStatus(input.cwd);
      }),

    [WS_METHODS.gitMergeLocally]: (payload) =>
      fromPromise("git.mergeLocally", async () => {
        const input = payload as GitMergeLocallyInput;
        const result = (await client.checkoutMerge(input.cwd, {
          baseRef: input.baseRef,
          strategy: "merge",
          requireCleanTarget: true,
        })) as unknown as NeolixCommandPayload;
        assertCommandSucceeded(result, `Failed to merge ${input.baseRef}.`, "git.merge-failed");
        invalidatePrStatus(input.cwd);
      }),

    [WS_METHODS.gitMergeFromBase]: (payload) =>
      fromPromise("git.mergeFromBase", async () => {
        const input = payload as GitMergeFromBaseInput;
        const result = (await client.checkoutMergeFromBase(input.cwd, {
          baseRef: input.baseRef,
          requireCleanTarget: true,
        })) as unknown as NeolixCommandPayload;
        assertCommandSucceeded(
          result,
          `Failed to update from ${input.baseRef}.`,
          "git.update-failed",
        );
        invalidatePrStatus(input.cwd);
      }),

    // No Neox route can create a branch in place, drop a stash, remove an index lock,
    // initialise a repository, stage files separately, or hand a thread to another checkout.
    // Answer with a typed "not supported" so the affected row reports the gap instead of
    // failing obscurely.
    [WS_METHODS.gitCreateBranch]: () => Effect.fail(notSupported(WS_METHODS.gitCreateBranch)),
    [WS_METHODS.gitStashDrop]: () => Effect.fail(notSupported(WS_METHODS.gitStashDrop)),
    [WS_METHODS.gitRemoveIndexLock]: () => Effect.fail(notSupported(WS_METHODS.gitRemoveIndexLock)),
    [WS_METHODS.gitInit]: () => Effect.fail(notSupported(WS_METHODS.gitInit)),
    [WS_METHODS.gitStageFiles]: () => Effect.fail(notSupported(WS_METHODS.gitStageFiles)),
    [WS_METHODS.gitUnstageFiles]: () => Effect.fail(notSupported(WS_METHODS.gitUnstageFiles)),
    [WS_METHODS.gitHandoffThread]: () => Effect.fail(notSupported(WS_METHODS.gitHandoffThread)),

    // Neox has no read-at-revision, blame, or index-separated diff route yet. Answer with a
    // typed "not supported" so the affected panes degrade instead of showing invented content.
    [WS_METHODS.gitReadFileAtRev]: () => Effect.fail(notSupported(WS_METHODS.gitReadFileAtRev)),
    [WS_METHODS.gitBlameLine]: () => Effect.fail(notSupported(WS_METHODS.gitBlameLine)),
  };
}
