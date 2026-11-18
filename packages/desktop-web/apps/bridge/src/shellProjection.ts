// The projection from daemon state to the web client's shell view. It owns the monotonic
// sequence that numbers every shell stream item, the daemon-derived projects, agents,
// workspaces and forge status, and the thread shells folded from them. Nothing here reads
// or writes bridge-local state such as drafts, imported transcripts or project aliases;
// `BridgeModel` feeds daemon facts in and publishes what comes out.
import type {
  GitStatusResult,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadShell,
  ProjectScript,
} from "@synara/contracts";

import { sep } from "node:path";

import { type NeolixProject, toProjectShell, toThreadShell } from "./translate.ts";
import type { FetchAgentsEntry } from "../../../../client/dist/daemon-client.js";

export type ShellListener = (item: OrchestrationShellStreamItem) => void;

export interface ProjectWorktreeCommands {
  readonly setup: string | null;
  readonly teardown: string | null;
}

export interface ProjectConfigProjection {
  readonly scripts: ProjectScript[];
  readonly worktree: ProjectWorktreeCommands;
}

export interface ProjectConfigPayloadLike {
  readonly ok: boolean;
  readonly config?: unknown;
}

interface WorkspaceRecord {
  readonly id: string;
  readonly pinnedAt?: string | null | undefined;
  readonly directory: string | null;
  readonly kind?: string | undefined;
  readonly branch?: string | null | undefined;
}

export interface ShellProjectionOptions {
  /** This host's home folder, when known; its project is the client's Home chat container. */
  readonly homeDir?: string | undefined;
  /** Bridge-local project pins; the daemon's project registry has no pin field. */
  readonly isProjectPinned?: ((projectId: string) => boolean) | undefined;
}

/** A lifecycle command may be one string or an array of lines, as `neox.json` allows both. */
export function lifecycleText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const text = value
    .filter((entry): entry is string => typeof entry === "string")
    .join("\n")
    .trim();
  return text || null;
}

/** The daemon relays the file system's own message, e.g. "ENOENT: no such file or directory". */
export function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOENT|ENOTDIR)\b|no such file or directory|not a directory/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the project's actions from its `neox.json` payload. Returns null when the daemon
 * could not read the file, so a transient failure keeps the last known list instead of
 * blanking the Actions section.
 */
export function projectConfigProjection(
  payload: ProjectConfigPayloadLike,
): ProjectConfigProjection | null {
  if (!payload.ok) return null;
  const config = isRecord(payload.config) ? payload.config : {};
  const worktree = isRecord(config.worktree) ? config.worktree : {};
  const projection: ProjectConfigProjection = {
    scripts: [],
    worktree: {
      setup: lifecycleText(worktree.setup),
      teardown: lifecycleText(worktree.teardown),
    },
  };
  const entries = config.scripts;
  if (!isRecord(entries)) return projection;
  const setupCommands = new Set(
    (typeof worktree.setup === "string"
      ? [worktree.setup]
      : Array.isArray(worktree.setup)
        ? worktree.setup
        : []
    )
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()),
  );
  for (const [rawName, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue;
    const name = rawName.trim();
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!name || !command) continue;
    const type = typeof entry.type === "string" && entry.type.trim() ? entry.type.trim() : null;
    const port =
      typeof entry.port === "number" || (typeof entry.port === "string" && entry.port.trim())
        ? entry.port
        : null;
    // The dialog has no icon field for a config script; `play` is the neutral default.
    projection.scripts.push({
      id: name,
      name,
      command,
      icon: "play",
      runOnWorktreeCreate: setupCommands.has(command),
      ...(type ? { type } : {}),
      ...(port !== null ? { port } : {}),
    });
  }
  return projection;
}

/**
 * Daemon state projected into the web client's shell view: one monotonic sequence for every
 * shell item, projects read from the daemon, and thread shells folded from its agents and
 * workspaces. The class is fed by `BridgeModel`; it never talks to the daemon itself.
 */
export class ShellProjection {
  private sequence = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly projects = new Map<string, OrchestrationProjectShell>();
  /**
   * The project's actions, read from its `neox.json`. The daemon's project descriptor has no
   * script list, so the bridge reads the config file the script runtime consumes.
   */
  private readonly projectScripts = new Map<string, ProjectScript[]>();
  /** The config's `worktree.setup` / `worktree.teardown`, projected onto the project shell. */
  private readonly projectWorktree = new Map<string, ProjectWorktreeCommands>();
  private readonly entries = new Map<string, FetchAgentsEntry>();
  private readonly shells = new Map<string, OrchestrationThreadShell>();
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
  private readonly shellListeners = new Set<ShellListener>();
  /** Project ids whose root folder the daemon reported missing; see `applyRootMissing`. */
  private readonly missingRoots = new Set<string>();

  constructor(private readonly options: ShellProjectionOptions = {}) {}

  next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  projectShell(project: NeolixProject): OrchestrationProjectShell {
    const shell = toProjectShell(
      project,
      this.startedAt,
      this.options.homeDir,
      this.options.isProjectPinned?.(project.projectId) ?? false,
      this.projectScripts.get(project.projectId) ?? [],
      this.projectWorktree.get(project.projectId) ?? { setup: null, teardown: null },
    );
    return this.missingRoots.has(project.projectId) ? { ...shell, rootMissing: true } : shell;
  }

  setProjectScripts(projectId: string, scripts: ProjectScript[]): void {
    this.projectScripts.set(projectId, scripts);
  }

  setProjectWorktree(projectId: string, worktree: ProjectWorktreeCommands): void {
    this.projectWorktree.set(projectId, worktree);
  }

  setProject(projectId: string, shell: OrchestrationProjectShell): void {
    this.projects.set(projectId, shell);
  }

  deleteProject(projectId: string): void {
    this.projects.delete(projectId);
    this.projectScripts.delete(projectId);
  }

  hasProject(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  projectIds(): string[] {
    return [...this.projects.keys()];
  }

  projectRoot(projectId: string): string | undefined {
    return this.projects.get(projectId)?.workspaceRoot;
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

  projectKind(projectId: string): OrchestrationProjectShell["kind"] | undefined {
    return this.projects.get(projectId)?.kind;
  }

  /** Projects whose root folder the periodic check verifies; chat containers have none. */
  projectsForRootCheck(): readonly OrchestrationProjectShell[] {
    return [...this.projects.values()].filter((shell) => shell.kind !== "chat");
  }

  /**
   * Records whether a project's root folder is gone and returns the republished shell, or
   * null when the state did not change (or the project left the list meanwhile).
   */
  applyRootMissing(projectId: string, missing: boolean): OrchestrationProjectShell | null {
    if (missing === this.missingRoots.has(projectId)) return null;
    if (missing) this.missingRoots.add(projectId);
    else this.missingRoots.delete(projectId);
    const current = this.projects.get(projectId);
    if (!current) return null;
    const { rootMissing: _previous, ...rest } = current;
    const next: OrchestrationProjectShell = missing ? { ...rest, rootMissing: true } : rest;
    this.projects.set(projectId, next);
    return next;
  }

  /** Every thread the daemon has reported, for bridge-wide reads such as full-history search. */
  entry(threadId: string): FetchAgentsEntry | undefined {
    return this.entries.get(threadId);
  }

  hasEntry(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  allEntries(): FetchAgentsEntry[] {
    return [...this.entries.values()];
  }

  setEntry(entry: FetchAgentsEntry): void {
    this.entries.set(entry.agent.id, entry);
  }

  latestTurn(threadId: string): OrchestrationThreadShell["latestTurn"] {
    return this.shells.get(threadId)?.latestTurn ?? null;
  }

  shell(threadId: string): OrchestrationThreadShell | undefined {
    return this.shells.get(threadId);
  }

  setShell(threadId: string, shell: OrchestrationThreadShell): void {
    this.shells.set(threadId, shell);
  }

  /** Drops the daemon-derived state for a thread that no longer exists. */
  removeEntry(threadId: string): void {
    this.entries.delete(threadId);
    this.shells.delete(threadId);
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

  /** Replaces the workspace registry from the daemon's list; worktrees are remembered too. */
  replaceWorkspaces(entries: readonly WorkspaceRecord[]): void {
    this.workspaces.clear();
    this.worktrees.clear();
    for (const workspace of entries) {
      this.setWorkspace(workspace.id, {
        pinnedAt: workspace.pinnedAt ?? null,
        directory: workspace.directory,
      });
      if (workspace.kind === "worktree" && workspace.directory) {
        this.rememberWorktree(workspace.directory, workspace.branch ?? null);
      }
    }
  }

  setWorkspace(
    workspaceId: string,
    workspace: { readonly pinnedAt: string | null; readonly directory: string | null },
  ): void {
    this.workspaces.set(workspaceId, workspace);
  }

  removeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
  }

  /** A workspace-label or pin write reaches the shell through the daemon's workspace update. */
  refreshWorkspaceShells(workspaceId: string): OrchestrationThreadShell[] {
    const updated: OrchestrationThreadShell[] = [];
    for (const entry of this.entries.values()) {
      const entryWorkspaceId =
        entry.agent.workspaceId?.trim() || this.workspaceIdForCwd(entry.agent.cwd);
      if (entryWorkspaceId !== workspaceId) continue;
      const shell = this.shellFor(entry, this.shells.get(entry.agent.id)?.latestTurn ?? null);
      this.shells.set(entry.agent.id, shell);
      updated.push(shell);
    }
    return updated;
  }

  /**
   * The bridge is not subscribed to the daemon's workspace-update stream, so a pin write
   * must update the local map itself; otherwise every shell keeps reporting the old
   * `isPinned` until the bridge reconnects.
   */
  noteWorkspacePinned(workspaceId: string, pinnedAt: string | null): OrchestrationThreadShell[] {
    const existing = this.workspaces.get(workspaceId);
    this.workspaces.set(workspaceId, {
      pinnedAt,
      directory: existing?.directory ?? null,
    });
    return this.refreshWorkspaceShells(workspaceId);
  }

  /** Folds the last forge status into the shells whose cwd it belongs to. */
  notePrStatus(cwd: string, pr: GitStatusResult["pr"]): OrchestrationThreadShell[] {
    const previous = this.prByCwd.get(cwd) ?? null;
    if (JSON.stringify(previous) === JSON.stringify(pr)) return [];
    this.prByCwd.set(cwd, pr);
    const updated: OrchestrationThreadShell[] = [];
    for (const entry of this.entries.values()) {
      if ((entry.agent.cwd ?? "") !== cwd) continue;
      const shell = this.shellFor(entry, this.shells.get(entry.agent.id)?.latestTurn ?? null);
      this.shells.set(entry.agent.id, shell);
      updated.push(shell);
    }
    return updated;
  }

  projectCount(): number {
    return this.projects.size;
  }

  threadCount(): number {
    return this.entries.size;
  }

  /**
   * A legacy agent snapshot may omit `workspaceId`. Match its cwd only when exactly one
   * workspace owns that directory: several sessions can share a checkout, and guessing
   * the first would attach their title and pin to the wrong one.
   */
  workspaceIdForCwd(cwd: string | undefined): string | null {
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

  shellFor(
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

  emitShell(item: OrchestrationShellStreamItem): void {
    for (const listener of this.shellListeners) listener(item);
  }

  emitProjectUpsert(project: OrchestrationProjectShell): void {
    this.emitShell({ kind: "project-upserted", sequence: this.next(), project });
  }

  emitProjectRemoved(projectId: string): void {
    this.emitShell({
      kind: "project-removed",
      sequence: this.next(),
      projectId: projectId as never,
    });
  }

  emitThreadUpsert(thread: OrchestrationThreadShell): void {
    this.emitShell({ kind: "thread-upserted", sequence: this.next(), thread });
  }

  emitThreadRemoved(threadId: string): void {
    this.emitShell({ kind: "thread-removed", sequence: this.next(), threadId: threadId as never });
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
}
