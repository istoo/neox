// Bridge-local state the daemon has no place for: drafts that have no agent yet, fork
// transcripts shown until Neox has its own timeline, user-requested stops, client-minted
// project ids and project pins. `BridgeModel` owns the daemon connection and the shell
// projection; this class owns only what the bridge itself remembers.
import type { OrchestrationMessage, OrchestrationThreadShell } from "@synara/contracts";

export interface ProjectPinSource {
  isPinned(projectId: string): boolean;
}

export interface DraftThreadStore {
  load(): Promise<readonly OrchestrationThreadShell[]>;
  save(drafts: readonly OrchestrationThreadShell[]): Promise<void>;
}

export interface BridgeLocalStateOptions {
  /** Bridge-local project pins; the daemon's project registry has no pin field. */
  readonly projectPins?: ProjectPinSource | undefined;
  /** Bridge-local store for drafts, which the daemon cannot list (see draftThreads.ts). */
  readonly draftThreads?: DraftThreadStore | undefined;
}

/** State that survives only as long as this bridge process, plus the two local stores. */
export class BridgeLocalState {
  private readonly drafts = new Map<string, OrchestrationThreadShell>();
  /** Fork transcripts the UI shows until Neox has its own timeline for the thread. */
  private readonly importedTranscripts = new Map<string, OrchestrationMessage[]>();
  /**
   * When the local user last canceled a turn, per thread. The daemon keeps no terminal
   * timeline row for a cancellation, so the read model turns this into stop/abort rows.
   */
  private readonly userStops = new Map<string, string>();
  /** Threads whose agent this bridge created before its `agent_update` arrived. */
  private readonly createdAgents = new Set<string>();
  /**
   * The client mints a project id before `project.create` and keeps using it; the daemon
   * assigns its own. Commands that name the client id resolve through this map.
   */
  private readonly projectAliases = new Map<string, string>();

  constructor(private readonly options: BridgeLocalStateOptions = {}) {}

  isProjectPinned(projectId: string): boolean {
    return this.options.projectPins?.isPinned(projectId) ?? false;
  }

  /**
   * A fork draft also needs its imported transcript and fork context, which live only in memory,
   * so it is not saved: restored without them it would be an empty chat posing as the fork.
   */
  persistDrafts(): void {
    const store = this.options.draftThreads;
    if (!store) return;
    const saved = [...this.drafts.values()].filter(
      (draft) => !(draft as { forkSourceThreadId?: unknown }).forkSourceThreadId,
    );
    void store.save(saved);
  }

  savedDrafts(): Promise<readonly OrchestrationThreadShell[]> {
    return this.options.draftThreads?.load() ?? Promise.resolve([]);
  }

  draft(threadId: string): OrchestrationThreadShell | undefined {
    return this.drafts.get(threadId);
  }

  hasDraft(threadId: string): boolean {
    return this.drafts.has(threadId);
  }

  setDraft(draft: OrchestrationThreadShell): void {
    this.drafts.set(draft.id, draft);
  }

  removeDraft(threadId: string): boolean {
    return this.drafts.delete(threadId);
  }

  /** Resolves and stores a draft, returning the shell the client should list. */
  registerDraft(draft: OrchestrationThreadShell): OrchestrationThreadShell {
    // A draft created right after `project.create` names the client's project id; list it under
    // the daemon's project so the sidebar groups it with the project the snapshot carries.
    const projectId = this.resolveProjectId(String(draft.projectId));
    const shell =
      projectId === String(draft.projectId)
        ? draft
        : { ...draft, projectId: projectId as OrchestrationThreadShell["projectId"] };
    this.drafts.set(shell.id, shell);
    this.persistDrafts();
    return shell;
  }

  /** Renames a draft; an empty title keeps the current one, as the daemon does for agents. */
  renameDraft(threadId: string, title: string): OrchestrationThreadShell | null {
    const draft = this.drafts.get(threadId);
    const trimmed = title.trim();
    if (!draft || !trimmed || draft.title === trimmed) return null;
    const next = {
      ...draft,
      title: trimmed as OrchestrationThreadShell["title"],
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(threadId, next);
    this.persistDrafts();
    return next;
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

  /** Records that this bridge asked the daemon to create the thread's agent. */
  markCreated(threadId: string): void {
    this.createdAgents.add(threadId);
  }

  wasCreated(threadId: string): boolean {
    return this.createdAgents.has(threadId);
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

  forgetThread(threadId: string): void {
    this.importedTranscripts.delete(threadId);
  }
}
