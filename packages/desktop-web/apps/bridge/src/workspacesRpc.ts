// Neox workspace metadata behind Synara threads. A Synara thread is a Neox agent; the title,
// pin, labels and unread mark live on the workspace that agent runs in. Every write resolves the
// agent's workspace id here so the fork's UI can stay thread-keyed.
import { WS_METHODS } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { bridgeError, fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

interface NeolixWorkspaceEntry {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly title?: string | null;
  readonly workspaceDirectory?: string;
  readonly projectRootPath?: string;
  readonly pinnedAt?: string | null;
  readonly labels?: ReadonlyArray<string>;
  readonly activityAt?: string | null;
  readonly status: string;
  readonly gitRuntime?: { readonly currentBranch?: string | null } | null;
  readonly githubRuntime?: {
    readonly pullRequest?: { readonly checksStatus?: string } | null;
  } | null;
  readonly diffStat?: { readonly additions: number; readonly deletions: number } | null;
  readonly scripts?: ReadonlyArray<{
    readonly type?: string;
    readonly lifecycle?: string;
  }>;
}

interface NeolixWorkspaceTarget {
  readonly threadId?: string;
  readonly workspaceId?: string;
}

interface NeolixArchivedAgent {
  readonly id: string;
  readonly cwd?: string;
  readonly workspaceId?: string;
  readonly title?: string | null;
  readonly archivedAt?: string | null;
}

interface NeolixArchivedAgentEntry {
  readonly agent: NeolixArchivedAgent;
  readonly project?: { readonly projectName?: string } | null;
}

type NeolixLabelColor =
  | "violet"
  | "sky"
  | "emerald"
  | "orange"
  | "pink"
  | "indigo"
  | "teal"
  | "red"
  | "amber"
  | "blue";

interface NeolixLabelDefinition {
  readonly name: string;
  readonly color: NeolixLabelColor;
}

async function listWorkspaces(model: BridgeModel): Promise<ReadonlyArray<NeolixWorkspaceEntry>> {
  const payload = (await model.client.fetchWorkspaces({
    page: { limit: 200 },
  })) as unknown as { entries: ReadonlyArray<NeolixWorkspaceEntry> };
  return payload.entries;
}

/**
 * The daemon has no route that enumerates archived workspace records. Archived agents are still
 * listed (`includeArchived`), and they carry the workspace id and directory, so group them into
 * one entry per archived workspace and drop ids the active workspace list still owns (an archived
 * conversation inside a live workspace is not a restorable workspace).
 */
async function listArchivedWorkspaces(model: BridgeModel) {
  const active = await listWorkspaces(model);
  const activeIds = new Set(active.map((workspace) => workspace.id));
  // debt: first agent page only, like the workspace read above. A host with more than 200
  // archived agents needs pagination here.
  const agents = (await model.client.fetchAgents({
    filter: { includeArchived: true },
    page: { limit: 200 },
  })) as unknown as { entries: ReadonlyArray<NeolixArchivedAgentEntry> };

  const groups = new Map<
    string,
    {
      workspaceId: string;
      directory: string;
      title: string | null;
      projectName: string | null;
      archivedAt: string;
      agentCount: number;
    }
  >();
  for (const entry of agents.entries) {
    const agent = entry.agent;
    const workspaceId = agent.workspaceId?.trim();
    const archivedAt = agent.archivedAt;
    if (!workspaceId || !archivedAt || activeIds.has(workspaceId)) continue;
    const directory = agent.cwd?.trim() ?? "";
    const title = agent.title?.trim() || null;
    const projectName = entry.project?.projectName?.trim() || null;
    const existing = groups.get(workspaceId);
    if (!existing) {
      groups.set(workspaceId, {
        workspaceId,
        directory,
        title,
        projectName,
        archivedAt,
        agentCount: 1,
      });
      continue;
    }
    existing.agentCount += 1;
    if (archivedAt > existing.archivedAt) existing.archivedAt = archivedAt;
    if (title) existing.title = title;
    existing.projectName ??= projectName;
  }
  return [...groups.values()].sort((left, right) =>
    right.archivedAt.localeCompare(left.archivedAt),
  );
}

async function resolveWorkspaceId(
  model: BridgeModel,
  target: NeolixWorkspaceTarget,
): Promise<string> {
  const explicit = target.workspaceId?.trim();
  if (explicit) return explicit;
  const threadId = target.threadId?.trim();
  if (!threadId) {
    throw bridgeError("workspace.target-required", "A thread or workspace is required.");
  }
  const agent = model.entry(threadId)?.agent as { workspaceId?: string; cwd?: string } | undefined;
  if (!agent) {
    throw bridgeError("workspace.unknown-thread", `Unknown thread ${threadId}.`, {
      thread: threadId,
    });
  }
  if (agent.workspaceId?.trim()) return agent.workspaceId.trim();
  // Older daemons do not put workspaceId on the agent snapshot; the directory is the join key.
  const cwd = agent.cwd?.trim();
  if (!cwd) {
    throw bridgeError("workspace.thread-no-workspace", `Thread ${threadId} has no workspace.`, {
      thread: threadId,
    });
  }
  const matches = (await listWorkspaces(model)).filter(
    (workspace) => workspace.workspaceDirectory === cwd || workspace.projectRootPath === cwd,
  );
  // Several sessions can share one checkout (each gets its own workspace record), so
  // the first directory match is not this thread's workspace. Refuse rather than pin,
  // rename or archive a sibling.
  if (matches.length > 1) {
    throw bridgeError(
      "workspace.ambiguous-shared-directory",
      `Thread ${threadId} has no workspace id and ${matches.length} workspaces share ${cwd}.`,
      { thread: threadId, count: matches.length, path: cwd },
    );
  }
  if (matches.length === 0) {
    throw bridgeError("workspace.not-registered", `No workspace is registered for ${cwd}.`, {
      path: cwd,
    });
  }
  return matches[0]!.id;
}

export function makeWorkspaceHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  return {
    [WS_METHODS.neolixWorkspacesList]: () =>
      fromPromise("neolix.workspaces.list", async () => ({
        workspaces: (await listWorkspaces(model)).map((workspace) => ({
          id: workspace.id,
          projectId: workspace.projectId,
          name: workspace.name,
          title: workspace.title ?? null,
          directory: workspace.workspaceDirectory ?? workspace.projectRootPath ?? "",
          pinnedAt: workspace.pinnedAt ?? null,
          labels: workspace.labels ?? [],
          activityAt: workspace.activityAt ?? null,
          status: workspace.status,
          branch: workspace.gitRuntime?.currentBranch ?? null,
          checksStatus: workspace.githubRuntime?.pullRequest?.checksStatus ?? null,
          diffStat: workspace.diffStat ?? null,
          runningServiceCount:
            workspace.scripts?.filter(
              (script) => script.type !== "script" && script.lifecycle === "running",
            ).length ?? 0,
        })),
      })),

    [WS_METHODS.neolixWorkspacesListArchived]: () =>
      fromPromise("neolix.workspaces.listArchived", async () => ({
        workspaces: await listArchivedWorkspaces(model),
      })),

    [WS_METHODS.neolixWorkspacesLabels]: () =>
      fromPromise("neolix.workspaces.labels", async () => {
        const payload = (await client.listWorkspaceLabels()) as unknown as {
          labels: ReadonlyArray<NeolixLabelDefinition>;
        };
        return { labels: payload.labels };
      }),

    [WS_METHODS.neolixWorkspacesSetPinned]: (payload) =>
      fromPromise("neolix.workspaces.setPinned", async () => {
        const input = payload as NeolixWorkspaceTarget & { pinned: boolean };
        const workspaceId = await resolveWorkspaceId(model, input);
        const result = await client.setWorkspacePinned(workspaceId, input.pinned);
        // Refresh the thread shells immediately; the daemon's event stream is not
        // consumed by the bridge.
        model.noteWorkspacePinned(workspaceId, result.pinnedAt);
        return result;
      }),

    [WS_METHODS.neolixWorkspacesSetTitle]: (payload) =>
      fromPromise("neolix.workspaces.setTitle", async () => {
        const input = payload as NeolixWorkspaceTarget & { title: string | null };
        const workspaceId = await resolveWorkspaceId(model, input);
        return client.setWorkspaceTitle(workspaceId, input.title);
      }),

    [WS_METHODS.neolixWorkspacesSetLabel]: (payload) =>
      fromPromise("neolix.workspaces.setLabel", async () => {
        const input = payload as NeolixWorkspaceTarget & {
          label: NeolixLabelDefinition;
          assigned: boolean;
        };
        const workspaceId = await resolveWorkspaceId(model, input);
        const assignment = (await client.setWorkspaceLabel({
          workspaceId,
          label: input.label,
          assigned: input.assigned,
        })) as unknown as { workspaceLabels: ReadonlyArray<string> };
        return { labels: assignment.workspaceLabels };
      }),

    [WS_METHODS.neolixWorkspacesMarkUnread]: (payload) =>
      fromPromise("neolix.workspaces.markUnread", async () => {
        const workspaceId = await resolveWorkspaceId(model, payload as NeolixWorkspaceTarget);
        await client.markWorkspaceUnread(workspaceId);
        return {};
      }),

    [WS_METHODS.neolixWorkspacesUpdateLabel]: (payload) =>
      fromPromise("neolix.workspaces.updateLabel", async () => {
        const input = payload as {
          name: string;
          newName?: string;
          color?: NeolixLabelColor;
        };
        const result = await client.updateWorkspaceLabel({
          name: input.name,
          ...(input.newName === undefined ? {} : { newName: input.newName }),
          ...(input.color === undefined ? {} : { color: input.color }),
        });
        return {
          label: result.label,
          affectedWorkspaceCount: result.affectedWorkspaceCount,
        };
      }),

    [WS_METHODS.neolixWorkspacesInspectLabelDelete]: (payload) =>
      fromPromise("neolix.workspaces.inspectLabelDelete", async () => {
        const input = payload as { name: string };
        const result = await client.inspectWorkspaceLabelDelete({ name: input.name });
        return { affectedWorkspaceCount: result.affectedWorkspaceCount };
      }),

    [WS_METHODS.neolixWorkspacesDeleteLabel]: (payload) =>
      fromPromise("neolix.workspaces.deleteLabel", async () => {
        const input = payload as { name: string };
        const result = await client.deleteWorkspaceLabel({ name: input.name });
        return { affectedWorkspaceCount: result.affectedWorkspaceCount };
      }),

    [WS_METHODS.neolixWorkspacesArchive]: (payload) =>
      fromPromise("neolix.workspaces.archive", async () => {
        const workspaceId = await resolveWorkspaceId(model, payload as NeolixWorkspaceTarget);
        const result = await client.archiveWorkspace(workspaceId);
        if (result.error) {
          throw bridgeError("workspace.archive-failed", result.error, { detail: result.error });
        }
        return { archivedAt: result.archivedAt };
      }),

    [WS_METHODS.neolixWorkspacesInspectRecovery]: (payload) =>
      fromPromise("neolix.workspaces.inspectRecovery", async () => {
        const input = payload as { workspaceId: string };
        return client.inspectWorkspaceRecovery(input.workspaceId);
      }),

    [WS_METHODS.neolixWorkspacesRestore]: (payload) =>
      fromPromise("neolix.workspaces.restore", async () => {
        const input = payload as { workspaceId: string };
        await client.restoreWorkspace(input.workspaceId);
        return {};
      }),
  };
}
