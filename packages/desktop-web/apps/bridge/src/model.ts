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
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  OrchestrationThreadStreamItem,
  ProjectScript,
} from "@synara/contracts";

import type { DaemonClient } from "./neolix.ts";
import { type NeolixProject, settleLatestTurn, toThread, toThreadTimeline } from "./translate.ts";
import type { FetchAgentsEntry } from "../../../../client/dist/daemon-client.js";
import { ThreadStream, type ThreadEntriesUpdate, diffThreadEvents } from "./threadStream.ts";
import { BridgeLocalState } from "./bridgeLocalState.ts";
import { ShellProjection, isMissingPathError, projectConfigProjection } from "./shellProjection.ts";

type ShellListener = (item: OrchestrationShellStreamItem) => void;
type ThreadListener = (item: OrchestrationThreadStreamItem) => void;

/** How often project roots are re-checked, so a folder moved or restored outside the app shows. */
const PROJECT_ROOT_CHECK_INTERVAL_MS = 60_000;

/** Coalesces bursts of streamed deltas into one catch-up per thread. */
const THREAD_REFRESH_MS = 120;

export class BridgeModel {
  private readonly projection: ShellProjection;
  private readonly local: BridgeLocalState;
  private readonly threadListeners = new Map<string, Set<ThreadListener>>();
  private readonly timelineSubscriptions = new Map<string, () => void>();
  private readonly stream: ThreadStream;
  /** The last detail this bridge pushed for a thread, so the next change can be a diff. */
  private readonly threadSnapshots = new Map<string, OrchestrationThread>();
  private rootCheckTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly client: DaemonClient,
    private readonly log: (line: string) => void,
    /** This host's home folder, when known; its project is the client's Home chat container. */
    readonly homeDir?: string,
    /** Bridge-local project pins; the daemon's project registry has no pin field. */
    projectPins?: { isPinned(projectId: string): boolean },
    /** Bridge-local store for drafts, which the daemon cannot list (see draftThreads.ts). */
    draftThreads?: {
      load(): Promise<readonly OrchestrationThreadShell[]>;
      save(drafts: readonly OrchestrationThreadShell[]): Promise<void>;
    },
  ) {
    this.local = new BridgeLocalState({ projectPins, draftThreads });
    this.projection = new ShellProjection({
      homeDir,
      isProjectPinned: (projectId) => this.local.isProjectPinned(projectId),
    });
    this.stream = new ThreadStream(this.client, {
      log: (line) => this.log(line),
      refreshMs: THREAD_REFRESH_MS,
    });
  }

  /**
   * Reads the project's actions from its `neox.json`. A read failure returns null so a transient
   * daemon error keeps the last known list instead of blanking the Actions section.
   */
  private async readProjectScripts(project: NeolixProject): Promise<ProjectScript[] | null> {
    const payload = await this.client.readProjectConfig(project.projectRootPath);
    const projection = projectConfigProjection(payload);
    if (!projection) return null;
    this.projection.setProjectWorktree(project.projectId, projection.worktree);
    return projection.scripts;
  }

  /**
   * Asks the daemon to list each project's root and republishes the projects whose folder
   * appeared or disappeared since the last check. Only "no such file" counts as missing: a
   * dropped connection or a permission error says nothing about the folder.
   */
  async refreshProjectRoots(): Promise<void> {
    const shells = this.projection.projectsForRootCheck();
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
      const next = this.projection.applyRootMissing(id, missing);
      if (next) this.projection.emitProjectUpsert(next);
    }
  }

  /** A sequence for a dispatch receipt; later shell and thread items are numbered after it. */
  nextSequence(): number {
    return this.projection.next();
  }

  entry(threadId: string): FetchAgentsEntry | undefined {
    return this.projection.entry(threadId);
  }

  /** Every thread the daemon has reported, for bridge-wide reads such as full-history search. */
  allEntries(): FetchAgentsEntry[] {
    return this.projection.allEntries();
  }

  /** Records that this bridge asked the daemon to create the thread's agent. */
  markCreated(threadId: string): void {
    this.local.markCreated(threadId);
  }

  wasCreated(threadId: string): boolean {
    return this.local.wasCreated(threadId) || this.projection.hasEntry(threadId);
  }

  setImportedTranscript(threadId: string, messages: OrchestrationMessage[]): void {
    this.local.setImportedTranscript(threadId, messages);
  }

  importedTranscript(threadId: string): readonly OrchestrationMessage[] {
    return this.local.importedTranscript(threadId);
  }

  /** Marks a user-requested stop so the next read-model fold can surface it. */
  recordUserStop(threadId: string): void {
    this.local.recordUserStop(threadId);
  }

  clearUserStop(threadId: string): void {
    this.local.clearUserStop(threadId);
  }

  userStoppedAt(threadId: string): string | null {
    return this.local.userStoppedAt(threadId);
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
    const shell = this.local.draft(threadId) ?? this.projection.shell(threadId);
    if (!shell) return;
    const next = {
      ...shell,
      envMode: workspace.envMode,
      branch: workspace.branch as OrchestrationThreadShell["branch"],
      worktreePath: workspace.worktreePath as OrchestrationThreadShell["worktreePath"],
    };
    if (this.local.hasDraft(threadId)) {
      this.local.setDraft(next);
      this.local.persistDrafts();
    }
    this.projection.setShell(threadId, next);
    this.projection.emitThreadUpsert(next);
  }

  /** Records a daemon-owned worktree so its agents keep a worktree thread shell. */
  rememberWorktree(path: string, branch: string | null): void {
    this.projection.rememberWorktree(path, branch);
  }

  /**
   * Records the workspace a freshly created worktree just registered. The daemon's
   * workspace_update stream is not subscribed here, so without this the first turn's
   * create-agent call cannot name the workspace and the daemon mints a second one
   * (and a stray project) for the same directory.
   */
  rememberWorkspace(workspaceId: string, directory: string): void {
    const trimmed = directory.trim().replace(/\/+$/, "");
    if (!workspaceId.trim() || !trimmed) return;
    this.projection.setWorkspace(workspaceId.trim(), { pinnedAt: null, directory: trimmed });
  }

  projectRoot(projectId: string): string | undefined {
    return this.projection.projectRoot(this.local.resolveProjectId(projectId));
  }

  /** The daemon project whose checkout is `cwd`, so a worktree joins its source project. */
  projectIdForCwd(cwd: string): string | undefined {
    return this.projection.projectIdForCwd(cwd);
  }

  /** Records the daemon id behind a client-minted project id. */
  aliasProject(clientProjectId: string, daemonProjectId: string): void {
    this.local.aliasProject(clientProjectId, daemonProjectId);
  }

  resolveProjectId(projectId: string): string {
    return this.local.resolveProjectId(projectId);
  }

  projectKind(projectId: string): OrchestrationProjectShell["kind"] | undefined {
    return this.projection.projectKind(this.local.resolveProjectId(projectId));
  }

  draft(threadId: string): OrchestrationThreadShell | undefined {
    return this.projection.hasEntry(threadId) ? undefined : this.local.draft(threadId);
  }

  /**
   * `thread.create` names a thread before Neox has an agent for it; the agent is created on
   * the first turn with the same id. Until then the shell lists the draft so the client can
   * promote it, exactly as it would a server-created empty thread.
   */
  registerDraft(draft: OrchestrationThreadShell): void {
    const shell = this.local.registerDraft(draft);
    this.projection.setShell(shell.id, shell);
    this.projection.emitThreadUpsert(shell);
  }

  /** Renames a draft; an empty title keeps the current one, as the daemon does for agents. */
  renameDraft(threadId: string, title: string): void {
    const next = this.local.renameDraft(threadId, title);
    if (!next) return;
    this.projection.setShell(threadId, next);
    this.projection.emitThreadUpsert(next);
  }

  /** True when no other loaded agent shares `workspaceId` with `agentId`. */
  isSoleWorkspaceAgent(agentId: string, workspaceId: string): boolean {
    for (const entry of this.projection.allEntries()) {
      if (entry.agent.id !== agentId && entry.agent.workspaceId?.trim() === workspaceId)
        return false;
    }
    return true;
  }

  /** Lists saved drafts that are still drafts and whose project the daemon still has. */
  private async restoreDrafts(): Promise<void> {
    const saved = await this.local.savedDrafts();
    let dropped = false;
    for (const draft of saved) {
      const projectId = this.local.resolveProjectId(String(draft.projectId));
      if (this.projection.hasEntry(draft.id) || !this.projection.hasProject(projectId)) {
        dropped = true;
        continue;
      }
      this.local.setDraft(draft);
      this.projection.setShell(draft.id, draft);
    }
    if (dropped) this.local.persistDrafts();
  }

  async load(): Promise<void> {
    const projects = (await this.client.listProjects()).projects as NeolixProject[];
    const scripts = await Promise.all(
      projects.map((project) => this.readProjectScripts(project).catch(() => null)),
    );
    for (const [index, project] of projects.entries()) {
      const projectScripts = scripts[index];
      if (projectScripts) this.projection.setProjectScripts(project.projectId, projectScripts);
      this.projection.setProject(project.projectId, this.projection.projectShell(project));
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
          const previous = this.projection.entry(event.payload.agent.id);
          this.upsertEntry(
            {
              agent: event.payload.agent,
              project: event.payload.project ?? previous?.project ?? null,
            } as FetchAgentsEntry,
            true,
          );
          this.stream.invalidate(event.payload.agent.id);
        } else {
          this.removeThread(event.agentId);
        }
      } else if (event.type === "agent_deleted") {
        this.removeThread(event.agentId);
      } else if (event.type === "workspace_update") {
        if (event.payload.kind === "upsert") {
          this.projection.setWorkspace(event.payload.workspace.id, {
            pinnedAt: event.payload.workspace.pinnedAt ?? null,
            directory:
              event.payload.workspace.workspaceDirectory?.replace(/\/+$/, "") ??
              event.payload.workspace.projectRootPath?.replace(/\/+$/, "") ??
              null,
          });
          this.emitWorkspaceShells(event.payload.workspace.id);
        } else {
          this.projection.removeWorkspace(event.payload.id);
          this.emitWorkspaceShells(event.payload.id);
        }
      } else if (event.type === "project.update") {
        void this.reloadProjects();
      }
    });
    this.log(
      `loaded ${this.projection.projectCount()} projects, ${this.projection.threadCount()} threads`,
    );
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
    this.stream.dispose();
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
    this.projection.replaceWorkspaces(
      payload.entries.map((workspace) => ({
        id: workspace.id,
        pinnedAt: workspace.pinnedAt ?? null,
        directory:
          workspace.workspaceDirectory?.replace(/\/+$/, "") ??
          workspace.projectRootPath?.replace(/\/+$/, "") ??
          null,
        kind: workspace.workspaceKind,
        branch: workspace.gitRuntime?.currentBranch ?? null,
      })),
    );
  }

  private emitWorkspaceShells(workspaceId: string): void {
    for (const shell of this.projection.refreshWorkspaceShells(workspaceId)) {
      this.projection.emitThreadUpsert(shell);
    }
  }

  /**
   * The bridge is not subscribed to the daemon's workspace-update stream, so a pin write
   * must update the local map itself; otherwise every shell keeps reporting the old
   * `isPinned` until the bridge reconnects.
   */
  noteWorkspacePinned(workspaceId: string, pinnedAt: string | null): void {
    for (const shell of this.projection.noteWorkspacePinned(workspaceId, pinnedAt)) {
      this.projection.emitThreadUpsert(shell);
    }
  }

  /** Folds the workspace pin and the last forge status into a thread shell. */
  notePrStatus(cwd: string, pr: GitStatusResult["pr"]): void {
    for (const shell of this.projection.notePrStatus(cwd, pr)) {
      this.projection.emitThreadUpsert(shell);
    }
  }

  /**
   * The workspace that owns a directory, when exactly one does. Placement uses this
   * to join an already-created worktree workspace instead of letting the daemon
   * provision a second one for the same directory.
   */
  workspaceIdForDirectory(cwd: string | undefined): string | null {
    return this.projection.workspaceIdForCwd(cwd);
  }

  /** Re-reads the project list: upserts what the daemon has, removes what it no longer has. */
  async reloadProjects(): Promise<void> {
    const projects = (await this.client.listProjects()).projects as NeolixProject[];
    const scripts = await Promise.all(
      projects.map((project) => this.readProjectScripts(project).catch(() => null)),
    );
    const current = new Set<string>();
    for (const [index, project] of projects.entries()) {
      current.add(project.projectId);
      const projectScripts = scripts[index];
      if (projectScripts) this.projection.setProjectScripts(project.projectId, projectScripts);
      const shell = this.projection.projectShell(project);
      this.projection.setProject(project.projectId, shell);
      this.projection.emitProjectUpsert(shell);
    }
    for (const projectId of this.projection.projectIds()) {
      if (current.has(projectId)) continue;
      // Agents keep a project key for folders that are not registered projects; keep those.
      if (this.projection.allEntries().some((entry) => entry.project?.projectKey === projectId))
        continue;
      this.projection.deleteProject(projectId);
      this.projection.emitProjectRemoved(projectId);
    }
    // A changed project path (or a new project) gets its folder state at once, not a minute later.
    await this.refreshProjectRoots().catch(() => undefined);
  }

  private upsertEntry(entry: FetchAgentsEntry, emit: boolean): void {
    const previousStatus = this.projection.entry(entry.agent.id)?.agent.status;
    const projectId = entry.project?.projectKey;
    if (projectId && !this.projection.hasProject(projectId) && entry.project) {
      const shell = this.projection.projectShell({
        projectId,
        projectDisplayName: entry.project.projectName,
        projectRootPath: entry.project.checkout.worktreeRoot ?? entry.agent.cwd,
      });
      this.projection.setProject(projectId, shell);
      if (emit) this.projection.emitProjectUpsert(shell);
    }
    this.projection.setEntry(entry);
    if (this.local.removeDraft(entry.agent.id)) this.local.persistDrafts();
    // A finished turn may have rewritten rows the incremental catch-up kept: reconcile once.
    if (previousStatus === "running" && entry.agent.status !== "running") {
      this.stream.reconcile(entry.agent.id);
    }
    // The timeline is only followed while a thread is open; a closed thread's turn settles
    // through its agent's status.
    const latestTurn = settleLatestTurn(entry.agent, this.projection.latestTurn(entry.agent.id));
    const shell = this.projection.shellFor(entry, latestTurn);
    this.projection.setShell(entry.agent.id, shell);
    if (emit) this.projection.emitThreadUpsert(shell);
  }

  private removeThread(agentId: string): void {
    this.projection.removeEntry(agentId);
    this.local.forgetThread(agentId);
    this.threadSnapshots.delete(agentId);
    this.stream.forget(agentId);
    this.projection.emitThreadRemoved(agentId);
  }

  /**
   * Drops a draft the daemon never heard of (no agent was created for it). Returns false for
   * threads that have an agent, which must be deleted through the daemon instead.
   */
  discardDraft(threadId: string): boolean {
    if (this.wasCreated(threadId) || !this.local.hasDraft(threadId)) return false;
    this.local.removeDraft(threadId);
    this.local.persistDrafts();
    this.removeThread(threadId);
    return true;
  }

  shellSnapshot(): OrchestrationShellSnapshot {
    return this.projection.shellSnapshot();
  }

  subscribeShell(listener: ShellListener): () => void {
    return this.projection.subscribeShell(listener);
  }

  async threadDetail(threadId: string): Promise<OrchestrationThreadDetailSnapshot | null> {
    const imported = this.importedTranscript(threadId);
    const entry = this.projection.entry(threadId);
    if (!entry) {
      const draft = this.local.draft(threadId);
      return draft
        ? {
            snapshotSequence: this.projection.next(),
            thread: toThread(draft, {
              messages: [...imported],
              activities: [],
              proposedPlans: [],
              latestTurn: null,
            }),
          }
        : null;
    }
    const timelineEntries = await this.stream.readFull(threadId);
    const latestEntry = this.projection.entry(threadId) ?? entry;
    const folded = toThreadTimeline(latestEntry.agent, timelineEntries, {
      userStoppedAt: this.userStoppedAt(threadId),
    });
    const shell = this.projection.shellFor(latestEntry, folded.latestTurn);
    this.projection.setShell(threadId, shell);
    const thread = toThread(shell, { ...folded, messages: [...imported, ...folded.messages] });
    // The caller applies this snapshot, so the next stream update may be a diff against it.
    this.threadSnapshots.set(threadId, thread);
    return { snapshotSequence: this.projection.next(), thread };
  }

  subscribeThread(threadId: string, listener: ThreadListener): () => void {
    let listeners = this.threadListeners.get(threadId);
    if (!listeners) {
      listeners = new Set([listener]);
      this.threadListeners.set(threadId, listeners);
      // The client's stream only signals that rows changed; the row cache decides what to read.
      const subscription = this.client.subscribeAgentTimeline(threadId, (message) => {
        if (message.type !== "agent.timeline.error") this.stream.invalidate(threadId);
      });
      const unwatch = this.stream.watch(threadId, (update) => {
        this.publishThreadEntries(threadId, update);
      });
      this.timelineSubscriptions.set(threadId, () => {
        subscription();
        unwatch();
      });
    } else {
      listeners.add(listener);
      const cached = this.stream.rows(threadId);
      if (cached) {
        this.publishThreadEntries(
          threadId,
          { threadId, entries: cached, full: false },
          new Set([listener]),
        );
      }
    }
    return () => {
      const current = this.threadListeners.get(threadId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.threadListeners.delete(threadId);
        this.timelineSubscriptions.get(threadId)?.();
        this.timelineSubscriptions.delete(threadId);
        // A later subscription starts from a snapshot, exactly as the first one did.
        this.threadSnapshots.delete(threadId);
      }
    };
  }

  /** Folds the cached rows and pushes the result to the thread's listeners. */
  private publishThreadEntries(
    threadId: string,
    update: ThreadEntriesUpdate,
    only?: ReadonlySet<ThreadListener>,
  ): void {
    const entry = this.projection.entry(threadId);
    if (!entry) return;
    try {
      const folded = toThreadTimeline(entry.agent, update.entries, {
        userStoppedAt: this.userStoppedAt(threadId),
      });
      const shell = this.projection.shellFor(entry, folded.latestTurn);
      this.projection.setShell(threadId, shell);
      const thread = toThread(shell, {
        ...folded,
        messages: [...this.importedTranscript(threadId), ...folded.messages],
      });
      const targets = only ?? this.threadListeners.get(threadId);
      // A newcomer has no previous detail, so it gets a snapshot; the others accept a tail
      // diff when the change is expressible as events and a snapshot otherwise.
      const events = only
        ? null
        : diffThreadEvents({
            previous: this.threadSnapshots.get(threadId) ?? null,
            next: thread,
            nextSequence: () => this.projection.next(),
          });
      if (events === null) {
        const snapshot = { snapshotSequence: this.projection.next(), thread };
        for (const listener of targets ?? []) listener({ kind: "snapshot", snapshot });
      } else if (events.length > 0) {
        for (const listener of targets ?? []) {
          for (const event of events) listener({ kind: "event", event });
        }
      }
      this.threadSnapshots.set(threadId, thread);
      this.projection.emitThreadUpsert(shell);
    } catch (error) {
      this.log(
        `thread ${threadId} refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
