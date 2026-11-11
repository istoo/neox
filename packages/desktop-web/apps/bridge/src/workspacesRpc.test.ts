import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { makeWorkspaceHandlers } from "./workspacesRpc.ts";

const WORKSPACE = {
  id: "ws-1",
  projectId: "prj-1",
  name: "feature/plugins",
  title: "Plugins",
  workspaceDirectory: "/repo",
  projectRootPath: "/repo",
  pinnedAt: "2026-01-01T00:00:00.000Z",
  labels: ["Urgent"],
  activityAt: "2026-01-01T00:00:00.000Z",
  status: "idle",
};

function makeHandlers(input: { workspaceId?: string; workspaces?: unknown[] } = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    fetchWorkspaces: async () => {
      calls.push(["fetchWorkspaces", undefined]);
      return { entries: input.workspaces ?? [WORKSPACE] };
    },
    listWorkspaceLabels: async () => {
      calls.push(["listWorkspaceLabels", undefined]);
      return { labels: [{ name: "Urgent", color: "red" }] };
    },
    setWorkspacePinned: async (workspaceId: string, pinned: boolean) => {
      calls.push(["setWorkspacePinned", { workspaceId, pinned }]);
      return { pinnedAt: pinned ? "2026-01-02T00:00:00.000Z" : null };
    },
    setWorkspaceTitle: async (workspaceId: string, title: string | null) => {
      calls.push(["setWorkspaceTitle", { workspaceId, title }]);
      return { title };
    },
    setWorkspaceLabel: async (payload: unknown) => {
      calls.push(["setWorkspaceLabel", payload]);
      return { workspaceLabels: ["Urgent", "Blocked"] };
    },
    markWorkspaceUnread: async (workspaceId: string) => {
      calls.push(["markWorkspaceUnread", workspaceId]);
    },
    updateWorkspaceLabel: async (input: unknown) => {
      calls.push(["updateWorkspaceLabel", input]);
      return {
        label: { name: "Urgent!", color: "amber" },
        affectedWorkspaceCount: 2,
      };
    },
    inspectWorkspaceLabelDelete: async (input: unknown) => {
      calls.push(["inspectWorkspaceLabelDelete", input]);
      return { affectedWorkspaceCount: 3 };
    },
    deleteWorkspaceLabel: async (input: unknown) => {
      calls.push(["deleteWorkspaceLabel", input]);
      return { affectedWorkspaceCount: 3 };
    },
    archiveWorkspace: async (workspaceId: string) => {
      calls.push(["archiveWorkspace", workspaceId]);
      return { workspaceId, archivedAt: "2026-01-03T00:00:00.000Z", error: null };
    },
    inspectWorkspaceRecovery: async (workspaceId: string) => {
      calls.push(["inspectWorkspaceRecovery", workspaceId]);
      return {
        kind: "recoverable",
        workspaceId,
        workspaceName: "feature/plugins",
        action: "restore",
        branch: "feature/plugins",
      };
    },
    restoreWorkspace: async (workspaceId: string) => {
      calls.push(["restoreWorkspace", workspaceId]);
    },
    fetchAgents: async (options: unknown) => {
      calls.push(["fetchAgents", options]);
      return {
        entries: [
          {
            agent: {
              id: "agent-old-1",
              cwd: "/repo/old",
              workspaceId: "ws-old",
              title: "Old chat",
              archivedAt: "2026-01-04T00:00:00.000Z",
            },
            project: { projectName: "Repo" },
          },
          {
            agent: {
              id: "agent-old-2",
              cwd: "/repo/old",
              workspaceId: "ws-old",
              title: "Newer old chat",
              archivedAt: "2026-01-05T00:00:00.000Z",
            },
            project: { projectName: "Repo" },
          },
          {
            agent: {
              id: "agent-active-workspace",
              cwd: "/repo",
              workspaceId: "ws-1",
              title: "Live chat",
              archivedAt: "2026-01-06T00:00:00.000Z",
            },
            project: { projectName: "Repo" },
          },
          {
            agent: {
              id: "agent-no-workspace",
              cwd: "/repo",
              title: "Orphan",
              archivedAt: "2026-01-07T00:00:00.000Z",
            },
            project: { projectName: "Repo" },
          },
        ],
      };
    },
  } as unknown as DaemonClient;
  const model = {
    client,
    noteWorkspacePinned: () => {},
    entry: (threadId: string) =>
      threadId === "unknown-thread"
        ? undefined
        : {
            agent: {
              id: threadId,
              cwd: "/repo",
              ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
            },
          },
  } as unknown as BridgeModel;
  return { handlers: makeWorkspaceHandlers(model), calls };
}

const run = <A>(effect: unknown) => Effect.runPromise(effect as Effect.Effect<A>);

describe("workspacesRpc", () => {
  it("lists workspaces with title, pin and labels", async () => {
    const { handlers } = makeHandlers();
    const result = await run(handlers[WS_METHODS.neolixWorkspacesList]!(undefined, undefined));
    expect(result).toEqual({
      workspaces: [
        expect.objectContaining({
          id: "ws-1",
          title: "Plugins",
          directory: "/repo",
          pinnedAt: "2026-01-01T00:00:00.000Z",
          labels: ["Urgent"],
        }),
      ],
    });
  });

  it("lists label definitions", async () => {
    const { handlers } = makeHandlers();
    await expect(
      run(handlers[WS_METHODS.neolixWorkspacesLabels]!(undefined, undefined)),
    ).resolves.toEqual({ labels: [{ name: "Urgent", color: "red" }] });
  });

  it("resolves a thread's workspace id and pins it", async () => {
    const { handlers, calls } = makeHandlers({ workspaceId: "ws-1" });
    const result = await run(
      handlers[WS_METHODS.neolixWorkspacesSetPinned]!(
        { threadId: "thread-1", pinned: true },
        undefined,
      ),
    );
    expect(result).toEqual({ pinnedAt: "2026-01-02T00:00:00.000Z" });
    expect(calls).toContainEqual(["setWorkspacePinned", { workspaceId: "ws-1", pinned: true }]);
  });

  it("refuses the directory fallback when several workspaces share one checkout", async () => {
    const { handlers, calls } = makeHandlers({
      workspaces: [WORKSPACE, { ...WORKSPACE, id: "ws-2", title: "Second session" }],
    });
    await expect(
      run(
        handlers[WS_METHODS.neolixWorkspacesSetPinned]!(
          { threadId: "thread-1", pinned: true },
          undefined,
        ),
      ),
    ).rejects.toThrow("2 workspaces share");
    expect(calls.some(([name]) => name === "setWorkspacePinned")).toBe(false);
  });

  it("falls back to the workspace directory for agents without workspaceId", async () => {
    const { handlers, calls } = makeHandlers();
    await run(
      handlers[WS_METHODS.neolixWorkspacesSetTitle]!(
        { threadId: "thread-1", title: "Renamed" },
        undefined,
      ),
    );
    expect(calls).toContainEqual(["setWorkspaceTitle", { workspaceId: "ws-1", title: "Renamed" }]);
  });

  it("assigns labels and marks the workspace unread", async () => {
    const { handlers, calls } = makeHandlers({ workspaceId: "ws-1" });
    const label = { name: "Blocked", color: "red" as const };
    await run(
      handlers[WS_METHODS.neolixWorkspacesSetLabel]!(
        { threadId: "thread-1", label, assigned: true },
        undefined,
      ),
    );
    await run(
      handlers[WS_METHODS.neolixWorkspacesMarkUnread]!({ threadId: "thread-1" }, undefined),
    );
    expect(calls).toContainEqual([
      "setWorkspaceLabel",
      { workspaceId: "ws-1", label, assigned: true },
    ]);
    expect(calls).toContainEqual(["markWorkspaceUnread", "ws-1"]);
  });

  it("updates, inspects and deletes catalog labels", async () => {
    const { handlers, calls } = makeHandlers();
    await expect(
      run(
        handlers[WS_METHODS.neolixWorkspacesUpdateLabel]!(
          { name: "Urgent", newName: "Urgent!", color: "amber" },
          undefined,
        ),
      ),
    ).resolves.toEqual({
      label: { name: "Urgent!", color: "amber" },
      affectedWorkspaceCount: 2,
    });
    await expect(
      run(handlers[WS_METHODS.neolixWorkspacesInspectLabelDelete]!({ name: "Urgent!" }, undefined)),
    ).resolves.toEqual({ affectedWorkspaceCount: 3 });
    await expect(
      run(handlers[WS_METHODS.neolixWorkspacesDeleteLabel]!({ name: "Urgent!" }, undefined)),
    ).resolves.toEqual({ affectedWorkspaceCount: 3 });
    expect(calls).toContainEqual([
      "updateWorkspaceLabel",
      { name: "Urgent", newName: "Urgent!", color: "amber" },
    ]);
    expect(calls).toContainEqual(["inspectWorkspaceLabelDelete", { name: "Urgent!" }]);
    expect(calls).toContainEqual(["deleteWorkspaceLabel", { name: "Urgent!" }]);
  });

  it("archives, inspects recovery and restores a workspace", async () => {
    const { handlers, calls } = makeHandlers({ workspaceId: "ws-1" });
    await expect(
      run(handlers[WS_METHODS.neolixWorkspacesArchive]!({ threadId: "thread-1" }, undefined)),
    ).resolves.toEqual({ archivedAt: "2026-01-03T00:00:00.000Z" });
    await expect(
      run(
        handlers[WS_METHODS.neolixWorkspacesInspectRecovery]!({ workspaceId: "ws-1" }, undefined),
      ),
    ).resolves.toMatchObject({ kind: "recoverable", branch: "feature/plugins" });
    await expect(
      run(handlers[WS_METHODS.neolixWorkspacesRestore]!({ workspaceId: "ws-1" }, undefined)),
    ).resolves.toEqual({});
    expect(calls).toContainEqual(["archiveWorkspace", "ws-1"]);
    expect(calls).toContainEqual(["inspectWorkspaceRecovery", "ws-1"]);
    expect(calls).toContainEqual(["restoreWorkspace", "ws-1"]);
  });

  it("derives archived workspaces from archived agents, excluding active workspace ids", async () => {
    const { handlers, calls } = makeHandlers();
    const result = (await run(
      handlers[WS_METHODS.neolixWorkspacesListArchived]!(undefined, undefined),
    )) as {
      workspaces: Array<Record<string, unknown>>;
    };
    expect(result.workspaces).toEqual([
      {
        workspaceId: "ws-old",
        directory: "/repo/old",
        title: "Newer old chat",
        projectName: "Repo",
        archivedAt: "2026-01-05T00:00:00.000Z",
        agentCount: 2,
      },
    ]);
    expect(calls).toContainEqual([
      "fetchAgents",
      { filter: { includeArchived: true }, page: { limit: 200 } },
    ]);
  });
});
