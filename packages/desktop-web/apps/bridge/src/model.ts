// The bridge's read model: Neox projects and agents held as Synara shells, a single monotonic
// sequence for every shell and thread item, and per-thread detail rebuilt from the Neox
// timeline. Thread changes are published as whole-thread snapshots with a fresh sequence; the
// front end applies a snapshot whenever its sequence is newer (__root.tsx EventRouter).
import type {
  GitStatusResult,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  OrchestrationThreadStreamItem,
} from "@synara/contracts";

import { sep } from "node:path";

import type { DaemonClient } from "./neolix.ts";
import {
  type NeolixProject,
  settleLatestTurn,
  toProjectShell,
  toThread,
  toThreadShell,
  toThreadTimeline,
} from "./translate.ts";
import type { FetchAgentsEntry } from "../../../../client/dist/daemon-client.js";

type ShellListener = (item: OrchestrationShellStreamItem) => void;
type ThreadListener = (item: OrchestrationThreadStreamItem) => void;

/** How often project roots are re-checked, so a folder moved or restored outside the app shows. */
const PROJECT_ROOT_CHECK_INTERVAL_MS = 60_000;

/** The daemon relays the file system's own message, e.g. "ENOENT: no such file or directory". */
export function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOENT|ENOTDIR)\b|no such file or directory|not a directory/i.test(message);
}

/** Coalesces bursts of streamed deltas into one re-read per thread. */
const THREAD_REFRESH_MS = 120;

export class BridgeModel {
  private sequence = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly projects = new Map<string, OrchestrationProjectShell>();
  private readonly entries = new Map<string, FetchAgentsEntry>();
  private readonly shells = new Map<string, OrchestrationThreadShell>();
  private readonly drafts = new Map<string, OrchestrationThreadShell>();
  /** Workspace metadata the thread shell folds in: a workspace pin is a thread pin. */
  private readonly workspaces = new Map<
    string,
    { readonly pinnedAt: string | null; readonly directory: string | null }
  >();
  /**
   * Worktrees the daemon owns, keyed by checkout path. Agents created with a bare `cwd` do not
   * carry `workspaceId`, so the daemon reports them as local checkouts; this registry restores
   * their worktree identity from the workspace list and from bridge-created worktrees.
   */
  private readonly worktrees = new Map<
    string,
    { readonly path: string; readonly branch: string | null }
  >();
  /** Last pull request the bridge saw for a checkout, keyed by cwd for `lastKnownPr`. */
  private readonly prByCwd = new Map<string, GitStatusResult["pr"]>();
  /** Threads whose agent this bridge created before its `agent_update` arrived. */
  private readonly createdAgents = new Set<string>();
  /** Fork transcripts the UI shows until Neox has its own timeline for the thread. */
  private readonly importedTranscripts = new Map<string, OrchestrationMessage[]>();
  /**
   * When the local user last canceled a turn, per thread. The daemon keeps no terminal
   * timeline row for a cancellation, so the read model turns this into stop/abort rows.
   */
  private readonly userStops = new Map<string, string>();
  private readonly shellListeners = new Set<ShellListener>();
  private readonly threadListeners = new Map<string, Set<ThreadListener>>();
  private readonly timelineSubscriptions = new Map<string, () => void>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * The client mints a project id before `project.create` and keeps using it; the daemon
   * assigns its own. Commands that name the client id resolve through this map.
   */
  private readonly projectAliases = new Map<string, string>();
  /** Project ids whose root folder the daemon reported missing; see `refreshProjectRoots`. */
  private readonly missingRoots = new Set<string>();
  private rootCheckTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly client: DaemonClient,
    private readonly log: (line: string) => void,
    /** This host's home folder, when known; its project is the client's Home chat container. */
    readonly homeDir?: string,
    /** Bridge-local project pins; the daemon's project registry has no pin field. */
    private readonly projectPins?: { isPinned(projectId: string): boolean },
    /** Bridge-local store for drafts, which the daemon cannot list (see draftThreads.ts). */
    private readonly draftThreads?: {
      load(): Promise<readonly OrchestrationThreadShell[]>;
      save(drafts: readonly OrchestrationThreadShell[]): Promise<void>;
    },
  ) {}

  /**
   * A fork draft also needs its imported transcript and fork context, which live only in memory,
   * so it is not saved: restored without them it would be an empty chat posing as the fork.
   */
  private persistDrafts(): void {
    if (!this.draftThreads) return;
    const saved = [...this.drafts.values()].filter(
      (draft) => !(draft as { forkSourceThreadId?: unknown }).forkSourceThreadId,
    );
    void this.draftThreads.save(saved);
  }

  private projectShell(project: NeolixProject): OrchestrationProjectShell {
    const shell = toProjectShell(
      project,
      this.startedAt,
      this.homeDir,
      this.projectPins?.isPinned(project.projectId) ?? false,
    );
    return this.missingRoots.has(project.projectId) ? { ...shell, rootMissing: true } : shell;
  }

  /**
   * Asks the daemon to list each project's root and republishes the projects whose folder
   * appeared or disappeared since the last check. Only "no such file" counts as missing: a
   * dropped connection or a permission error says nothing about the folder.
   */
  async refreshProjectRoots(): Promise<void> {
    const shells = [...this.projects.values()].filter((shell) => shell.kind !== "chat");
    const states = await Promise.all(
      shells.map(async (shell) => ({
        id: shell.id as string,
        missing: await this.client.listDirectory(shell.workspaceRoot, ".").then(
          () => false,
          (error: unknown) => isMissingPathError(error),
        ),
      })),
    );
    for (const { id, missing } of states) {
      if (missing === this.missingRoots.has(id)) continue;
      if (missing) this.missingRoots.add(id);
      else this.missingRoots.delete(id);
      const current = this.projects.get(id);
      if (!current) continue;
      const { rootMissing: _previous, ...rest } = current;
      const next: OrchestrationProjectShell = missing ? { ...rest, rootMissing: true } : rest;
      this.projects.set(id, next);
      this.emitShell({ kind: "project-upserted", sequence: this.next(), project: next });
    }
  }

  private next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** A sequence for a dispatch receipt; later shell and thread items are numbered after it. */
  nextSequence(): number {
    return this.next();
  }

  entry(threadId: string): FetchAgentsEntry | undefined {
    return this.entries.get(threadId);
  }

  /** Every thread the daemon has reported, for bridge-wide reads such as full-history search. */
  allEntries(): FetchAgentsEntry[] {
    return [...this.entries.values()];
  }

  /** Records that this bridge asked the daemon to create the thread's agent. */
  markCreated(threadId: string): void {
    this.createdAgents.add(threadId);
  }

  wasCreated(threadId: string): boolean {
    return this.createdAgents.has(threadId) || this.entries.has(threadId);
  }

  setImportedTranscript(threadId: string, messages: OrchestrationMessage[]): void {
    this.importedTranscripts.set(threadId, messages);
  }

  importedTranscript(threadId: string): readonly OrchestrationMessage[] {
    return this.importedTranscripts.get(threadId) ?? [];
  }

  /** Marks a user-requested stop so the next read-model fold can surface it. */
  recordUserStop(threadId: string): void {
    this.userStops.set(threadId, new Date().toISOString());
  }

  clearUserStop(threadId: string): void {
    this.userStops.delete(threadId);
  }

  userStoppedAt(threadId: string): string | null {
    return this.userStops.get(threadId) ?? null;
  }

  /** A worktree created on the first send becomes the draft thread's workspace. */
  updateDraftWorkspace(
    threadId: string,
    workspace: {
      readonly envMode: "local" | "worktree";
      readonly branch: string | null;
      readonly worktreePath: string | null;
    },
  ): void {
    const shell = this.drafts.get(threadId) ?? this.shells.get(threadId);
    if (!shell) return;
    const next = {
      ...shell,
      envMode: workspace.envMode,
      branch: workspace.branch as OrchestrationThreadShell["branch"],
      worktreePath: workspace.worktreePath as OrchestrationThreadShell["worktreePath"],
    };
    if (this.drafts.has(threadId)) {
      this.drafts.set(threadId, next);
      this.persistDrafts();
    }
    this.shells.set(threadId, next);
    this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: next });
  }

  /** Records a daemon-owned worktree so its agents keep a worktree thread shell. */
  rememberWorktree(path: string, branch: string | null): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    this.worktrees.set(trimmed, { path: trimmed, branch: branch?.trim() || null });
  }

  private worktreeForCwd(
    cwd: string | null | undefined,
  ): { path: string; branch: string | null } | null {
    const normalized = cwd?.trim();
    if (!normalized) return null;
    let match: { path: string; branch: string | null } | null = null;
    for (const worktree of this.worktrees.values()) {
      const prefix = worktree.path.endsWith(sep) ? worktree.path : `${worktree.path}${sep}`;
      if (normalized !== worktree.path && !normalized.startsWith(prefix)) continue;
      if (!match || worktree.path.length > match.path.length) match = worktree;
    }
    return match;
  }

  projectRoot(projectId: string): string | undefined {
    return this.projects.get(this.resolveProjectId(projectId))?.workspaceRoot;
  }

  /** The daemon project whose checkout is `cwd`, so a worktree joins its source project. */
  projectIdForCwd(cwd: string): string | undefined {
    const normalized = cwd.trim();
    if (!normalized) return undefined;
    for (const [projectId, project] of this.projects) {
      if (project.workspaceRoot === normalized) return projectId;
    }
    return undefined;
  }

  /** Records the daemon id behind a client-minted project id. */
  aliasProject(clientProjectId: string, daemonProjectId: string): void {
    if (clientProjectId !== daemonProjectId) {
      this.projectAliases.set(clientProjectId, daemonProjectId);
    }
  }

  resolveProjectId(projectId: string): string {
    return this.projectAliases.get(projectId) ?? projectId;
  }

  projectKind(projectId: string): OrchestrationProjectShell["kind"] | undefined {
    return this.projects.get(this.resolveProjectId(projectId))?.kind;
  }

  draft(threadId: string): OrchestrationThreadShell | undefined {
    return this.entries.has(threadId) ? undefined : this.drafts.get(threadId);
  }

  /**
   * `thread.create` names a thread before Neox has an agent for it; the agent is created on
   * the first turn with the same id. Until then the shell lists the draft so the client can
   * promote it, exactly as it would a server-created empty thread.
   */
  registerDraft(draft: OrchestrationThreadShell): void {
    // A draft created right after `project.create` names the client's project id; list it under
    // the daemon's project so the sidebar groups it with the project the snapshot carries.
    const projectId = this.resolveProjectId(String(draft.projectId));
    const shell =
      projectId === String(draft.projectId)
        ? draft
        : { ...draft, projectId: projectId as OrchestrationThreadShell["projectId"] };
    this.drafts.set(shell.id, shell);
    this.shells.set(shell.id, shell);
    this.persistDrafts();
    this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: shell });
  }

  /** Renames a draft; an empty title keeps the current one, as the daemon does for agents. */
  renameDraft(threadId: string, title: string): void {
    const draft = this.drafts.get(threadId);
    const trimmed = title.trim();
    if (!draft || !trimmed || draft.title === trimmed) return;
    const next = {
      ...draft,
      title: trimmed as OrchestrationThreadShell["title"],
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(threadId, next);
    this.shells.set(threadId, next);
    this.persistDrafts();
    this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: next });
  }

  /** True when no other loaded agent shares `workspaceId` with `agentId`. */
  isSoleWorkspaceAgent(agentId: string, workspaceId: string): boolean {
    for (const [id, entry] of this.entries) {
      if (id !== agentId && entry.agent.workspaceId?.trim() === workspaceId) return false;
    }
    return true;
  }

  /** Lists saved drafts that are still drafts and whose project the daemon still has. */
  private async restoreDrafts(): Promise<void> {
    const saved = (await this.draftThreads?.load()) ?? [];
    let dropped = false;
    for (const draft of saved) {
      const projectId = this.resolveProjectId(String(draft.projectId));
      if (this.entries.has(draft.id) || !this.projects.has(projectId)) {
        dropped = true;
        continue;
      }
      this.drafts.set(draft.id, draft);
      this.shells.set(draft.id, draft);
    }
    if (dropped) this.persistDrafts();
  }

  async load(): Promise<void> {
    const projects = await this.client.listProjects();
    for (const project of projects.projects as NeolixProject[]) {
      this.projects.set(project.projectId, this.projectShell(project));
    }
    await this.reloadWorkspaces();
    // Archived threads stay in the model so the client can list and restore them; the shell
    // carries `archivedAt`, which is what the client filters on.
    const agents = await this.client.fetchAgents({
      subscribe: {},
      filter: { includeArchived: true },
    });
    for (const entry of agents.entries) this.upsertEntry(entry, false);
    await this.restoreDrafts();
    this.client.subscribe((event) => {
      if (event.type === "agent_update") {
        if (event.payload.kind === "upsert") {
          const previous = this.entries.get(event.payload.agent.id);
          this.upsertEntry(
            {
              agent: event.payload.agent,
              project: event.payload.project ?? previous?.project ?? null,
            } as FetchAgentsEntry,
            true,
          );
          this.scheduleThreadRefresh(event.payload.agent.id);
        } else {
          this.removeThread(event.agentId);
        }
      } else if (event.type === "agent_deleted") {
        this.removeThread(event.agentId);
      } else if (event.type === "workspace_update") {
        if (event.payload.kind === "upsert") {
          this.workspaces.set(event.payload.workspace.id, {
            pinnedAt: event.payload.workspace.pinnedAt ?? null,
            directory:
              event.payload.workspace.workspaceDirectory?.replace(/\/+$/, "") ??
              event.payload.workspace.projectRootPath?.replace(/\/+$/, "") ??
              null,
          });
          this.refreshWorkspaceShells(event.payload.workspace.id);
        } else {
          this.workspaces.delete(event.payload.id);
          this.refreshWorkspaceShells(event.payload.id);
        }
      } else if (event.type === "project.update") {
        void this.reloadProjects();
      }
    });
    this.log(`loaded ${this.projects.size} projects, ${this.entries.size} threads`);
    const checkRoots = () =>
      void this.refreshProjectRoots().catch((error: unknown) =>
        this.log(`project root check failed: ${String(error)}`),
      );
    checkRoots();
    this.rootCheckTimer = setInterval(checkRoots, PROJECT_ROOT_CHECK_INTERVAL_MS);
    this.rootCheckTimer.unref?.();
  }

  /** Stops the periodic project root check; a host session calls this when it disconnects. */
  dispose(): void {
    if (this.rootCheckTimer) clearInterval(this.rootCheckTimer);
    this.rootCheckTimer = undefined;
  }

  /** Workspace pins drive thread pins, so a reconnect re-reads them instead of trusting a cache. */
  private async reloadWorkspaces(): Promise<void> {
    const payload = (await this.client.fetchWorkspaces({ page: { limit: 200 } })) as unknown as {
      entries: ReadonlyArray<{
        readonly id: string;
        readonly pinnedAt?: string | null;
        readonly workspaceDirectory?: string;
        readonly projectRootPath?: string;
        readonly workspaceKind?: string;
        readonly gitRuntime?: { readonly currentBranch?: string | null } | null;
      }>;
    };
    this.workspaces.clear();
    this.worktrees.clear();
    for (const workspace of payload.entries) {
      this.workspaces.set(workspace.id, {
        pinnedAt: workspace.pinnedAt ?? null,
        directory:
          workspace.workspaceDirectory?.replace(/\/+$/, "") ??
          workspace.projectRootPath?.replace(/\/+$/, "") ??
          null,
      });
      if (workspace.workspaceKind === "worktree" && workspace.workspaceDirectory) {
        this.rememberWorktree(
          workspace.workspaceDirectory,
          workspace.gitRuntime?.currentBranch ?? null,
        );
      }
    }
  }

  /** A workspace-label or pin write reaches the shell through the daemon's workspace update. */
  private refreshWorkspaceShells(workspaceId: string): void {
    for (const entry of this.entries.values()) {
      const entryWorkspaceId =
        entry.agent.workspaceId?.trim() || this.workspaceIdForCwd(entry.agent.cwd);
      if (entryWorkspaceId !== workspaceId) continue;
      const shell = this.shellFor(entry, this.shells.get(entry.agent.id)?.latestTurn ?? null);
      this.shells.set(entry.agent.id, shell);
      this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: shell });
    }
  }

  /**
   * The bridge is not subscribed to the daemon's workspace-update stream, so a pin write
   * must update the local map itself; otherwise every shell keeps reporting the old
   * `isPinned` until the bridge reconnects.
   */
  noteWorkspacePinned(workspaceId: string, pinnedAt: string | null): void {
    const existing = this.workspaces.get(workspaceId);
    this.workspaces.set(workspaceId, {
      pinnedAt,
      directory: existing?.directory ?? null,
    });
    this.refreshWorkspaceShells(workspaceId);
  }

  /** Folds the workspace pin and the last forge status into a thread shell. */
  notePrStatus(cwd: string, pr: GitStatusResult["pr"]): void {
    const previous = this.prByCwd.get(cwd) ?? null;
    if (JSON.stringify(previous) === JSON.stringify(pr)) return;
    this.prByCwd.set(cwd, pr);
    for (const entry of this.entries.values()) {
      if ((entry.agent.cwd ?? "") !== cwd) continue;
      const shell = this.shellFor(entry, this.shells.get(entry.agent.id)?.latestTurn ?? null);
      this.shells.set(entry.agent.id, shell);
      this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: shell });
    }
  }

  /**
   * A legacy agent snapshot may omit `workspaceId`. Match its cwd only when exactly one
   * workspace owns that directory: several sessions can share a checkout, and guessing
   * the first would attach their title and pin to the wrong one.
   */
  private workspaceIdForCwd(cwd: string | undefined): string | null {
    const key = cwd?.trim().replace(/\/+$/, "");
    if (!key) return null;
    let match: string | null = null;
    for (const [id, workspace] of this.workspaces) {
      if (workspace.directory !== key) continue;
      if (match !== null) return null;
      match = id;
    }
    return match;
  }

  /**
   * The workspace that owns a directory, when exactly one does. Placement uses this
   * to join an already-created worktree workspace instead of letting the daemon
   * provision a second one for the same directory.
   */
  workspaceIdForDirectory(cwd: string | undefined): string | null {
    return this.workspaceIdForCwd(cwd);
  }

  private shellFor(
    entry: FetchAgentsEntry,
    latestTurn: OrchestrationThreadShell["latestTurn"],
  ): OrchestrationThreadShell {
    const explicitWorkspaceId = entry.agent.workspaceId?.trim();
    const workspaceId = explicitWorkspaceId || this.workspaceIdForCwd(entry.agent.cwd) || undefined;
    const shell = toThreadShell(entry, latestTurn, {
      isPinned: workspaceId ? this.workspaces.get(workspaceId)?.pinnedAt != null : false,
      lastKnownPr: this.prByCwd.get(entry.agent.cwd) ?? null,
    });
    const withWorkspace =
      workspaceId && !shell.neolixWorkspaceId
        ? { ...shell, neolixWorkspaceId: workspaceId }
        : shell;
    // An agent created with a bare cwd is not joined to its worktree workspace, so the daemon
    // reports it as a local checkout. Restore what the daemon's workspace registry knows.
    if (withWorkspace.worktreePath) return withWorkspace;
    const worktree = this.worktreeForCwd(entry.agent.cwd);
    if (!worktree) return withWorkspace;
    return {
      ...withWorkspace,
      envMode: "worktree",
      branch: withWorkspace.branch ?? (worktree.branch as OrchestrationThreadShell["branch"]),
      worktreePath: worktree.path as OrchestrationThreadShell["worktreePath"],
    };
  }

  /** Re-reads the project list: upserts what the daemon has, removes what it no longer has. */
  async reloadProjects(): Promise<void> {
    const projects = await this.client.listProjects();
    const current = new Set<string>();
    for (const project of projects.projects as NeolixProject[]) {
      current.add(project.projectId);
      const shell = this.projectShell(project);
      this.projects.set(project.projectId, shell);
      this.emitShell({ kind: "project-upserted", sequence: this.next(), project: shell });
    }
    for (const projectId of [...this.projects.keys()]) {
      if (current.has(projectId)) continue;
      // Agents keep a project key for folders that are not registered projects; keep those.
      if ([...this.entries.values()].some((entry) => entry.project?.projectKey === projectId))
        continue;
      this.projects.delete(projectId);
      this.emitShell({
        kind: "project-removed",
        sequence: this.next(),
        projectId: projectId as never,
      });
    }
    // A changed project path (or a new project) gets its folder state at once, not a minute later.
    await this.refreshProjectRoots().catch(() => undefined);
  }

  private upsertEntry(entry: FetchAgentsEntry, emit: boolean): void {
    const projectId = entry.project?.projectKey;
    if (projectId && !this.projects.has(projectId) && entry.project) {
      const shell = this.projectShell({
        projectId,
        projectDisplayName: entry.project.projectName,
        projectRootPath: entry.project.checkout.worktreeRoot ?? entry.agent.cwd,
      });
      this.projects.set(projectId, shell);
      if (emit) this.emitShell({ kind: "project-upserted", sequence: this.next(), project: shell });
    }
    this.entries.set(entry.agent.id, entry);
    if (this.drafts.delete(entry.agent.id)) this.persistDrafts();
    // The timeline is only followed while a thread is open; a closed thread's turn settles
    // through its agent's status.
    const latestTurn = settleLatestTurn(
      entry.agent,
      this.shells.get(entry.agent.id)?.latestTurn ?? null,
    );
    const shell = this.shellFor(entry, latestTurn);
    this.shells.set(entry.agent.id, shell);
    if (emit) this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: shell });
  }

  private removeThread(agentId: string): void {
    this.entries.delete(agentId);
    this.shells.delete(agentId);
    this.importedTranscripts.delete(agentId);
    this.emitShell({ kind: "thread-removed", sequence: this.next(), threadId: agentId as never });
  }

  /**
   * Drops a draft the daemon never heard of (no agent was created for it). Returns false for
   * threads that have an agent, which must be deleted through the daemon instead.
   */
  discardDraft(threadId: string): boolean {
    if (this.wasCreated(threadId) || !this.drafts.has(threadId)) return false;
    this.drafts.delete(threadId);
    this.persistDrafts();
    this.removeThread(threadId);
    return true;
  }

  private emitShell(item: OrchestrationShellStreamItem): void {
    for (const listener of this.shellListeners) listener(item);
  }

  shellSnapshot(): OrchestrationShellSnapshot {
    return {
      snapshotSequence: this.sequence,
      spaces: [],
      projects: [...this.projects.values()],
      threads: [...this.shells.values()],
      updatedAt: new Date().toISOString(),
    };
  }

  subscribeShell(listener: ShellListener): () => void {
    this.shellListeners.add(listener);
    listener({ kind: "snapshot", snapshot: this.shellSnapshot() });
    return () => this.shellListeners.delete(listener);
  }

  async threadDetail(threadId: string): Promise<OrchestrationThreadDetailSnapshot | null> {
    const imported = this.importedTranscript(threadId);
    const entry = this.entries.get(threadId);
    if (!entry) {
      const draft = this.drafts.get(threadId);
      return draft
        ? {
            snapshotSequence: this.next(),
            thread: toThread(draft, {
              messages: [...imported],
              activities: [],
              proposedPlans: [],
              latestTurn: null,
            }),
          }
        : null;
    }
    const timeline = await this.client.fetchAgentTimeline(threadId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    const latestEntry = this.entries.get(threadId) ?? entry;
    const folded = toThreadTimeline(latestEntry.agent, timeline.entries, {
      userStoppedAt: this.userStops.get(threadId) ?? null,
    });
    const shell = this.shellFor(latestEntry, folded.latestTurn);
    this.shells.set(threadId, shell);
    return {
      snapshotSequence: this.next(),
      thread: toThread(shell, { ...folded, messages: [...imported, ...folded.messages] }),
    };
  }

  subscribeThread(threadId: string, listener: ThreadListener): () => void {
    let listeners = this.threadListeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.threadListeners.set(threadId, listeners);
      const subscription = this.client.subscribeAgentTimeline(threadId, (message) => {
        if (message.type !== "agent.timeline.error") this.scheduleThreadRefresh(threadId);
      });
      this.timelineSubscriptions.set(threadId, subscription);
    }
    listeners.add(listener);
    void this.publishThread(threadId, new Set([listener]));
    return () => {
      const current = this.threadListeners.get(threadId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.threadListeners.delete(threadId);
        this.timelineSubscriptions.get(threadId)?.();
        this.timelineSubscriptions.delete(threadId);
      }
    };
  }

  private scheduleThreadRefresh(threadId: string): void {
    if (!this.threadListeners.has(threadId) || this.refreshTimers.has(threadId)) return;
    this.refreshTimers.set(
      threadId,
      setTimeout(() => {
        this.refreshTimers.delete(threadId);
        const listeners = this.threadListeners.get(threadId);
        if (listeners) void this.publishThread(threadId, listeners);
      }, THREAD_REFRESH_MS),
    );
  }

  private async publishThread(threadId: string, listeners: Set<ThreadListener>): Promise<void> {
    try {
      const snapshot = await this.threadDetail(threadId);
      if (!snapshot) return;
      for (const listener of listeners) listener({ kind: "snapshot", snapshot });
      const shell = this.shells.get(threadId);
      if (shell) this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread: shell });
    } catch (error) {
      this.log(
        `thread ${threadId} refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
