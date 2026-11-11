import { describe, expect, it } from "vitest";

import type { DaemonClient } from "./neolix.ts";
import { BridgeModel } from "./model.ts";
import type { FetchAgentsEntry } from "../../../../client/dist/daemon-client.js";

const AT = "2026-11-05T05:27:06.873Z";

function makeEntry(archivedAt: string | null): FetchAgentsEntry {
  return {
    agent: {
      id: "4916614f-c855-4774-9cd0-d66d1f1baa96",
      provider: "claude",
      cwd: "/repo",
      model: "claude-sonnet-4-6",
      runtimeInfo: {
        provider: "claude",
        sessionId: "s1",
        model: "claude-sonnet-4-6",
        modeId: "default",
      },
      createdAt: AT,
      updatedAt: AT,
      lastUserMessageAt: AT,
      status: "idle",
      activeTurn: null,
      currentModeId: "default",
      availableModes: [],
      features: [],
      pendingPermissions: [],
      persistence: null,
      title: "Archived chat",
      labels: {},
      archivedAt,
    },
    project: null,
  } as unknown as FetchAgentsEntry;
}

describe("BridgeModel", () => {
  it("marks a project whose root folder is gone and clears it once the folder is back", async () => {
    const missing = new Set(["/gone"]);
    const listed: string[] = [];
    const client = {
      listProjects: async () => ({
        projects: [
          { projectId: "p-gone", projectDisplayName: "gone", projectRootPath: "/gone" },
          { projectId: "p-here", projectDisplayName: "here", projectRootPath: "/here" },
          { projectId: "p-flaky", projectDisplayName: "flaky", projectRootPath: "/flaky" },
        ],
      }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async () => ({ entries: [] }),
      listDirectory: async (cwd: string) => {
        listed.push(cwd);
        if (missing.has(cwd))
          throw new Error(`ENOENT: no such file or directory, realpath '${cwd}'`);
        if (cwd === "/flaky") throw new Error("Connection closed");
        return { path: ".", entries: [] };
      },
      subscribe: () => () => {},
    } as unknown as DaemonClient;

    const model = new BridgeModel(client, () => {});
    await model.load();
    await model.refreshProjectRoots();
    const rootMissing = () =>
      Object.fromEntries(model.shellSnapshot().projects.map((p) => [p.id, p.rootMissing ?? false]));
    // A transport failure is not evidence that the folder is gone.
    expect(rootMissing()).toEqual({ "p-gone": true, "p-here": false, "p-flaky": false });
    expect(listed).toEqual(expect.arrayContaining(["/gone", "/here", "/flaky"]));

    const upserts: unknown[] = [];
    model.subscribeShell((item) => {
      if (item.kind === "project-upserted") upserts.push(item.project);
    });
    missing.delete("/gone");
    await model.refreshProjectRoots();
    expect(rootMissing()["p-gone"]).toBe(false);
    expect(upserts).toEqual([expect.objectContaining({ id: "p-gone" })]);
    expect(upserts[0]).not.toHaveProperty("rootMissing");
    model.dispose();
  });

  it("loads archived agents and reports their archivedAt on the shell", async () => {
    let fetchOptions: unknown;
    const client = {
      listProjects: async () => ({ projects: [] }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async (options: unknown) => {
        fetchOptions = options;
        return { entries: [makeEntry("2026-11-06T01:00:00.000Z")] };
      },
      subscribe: () => () => {},
    } as unknown as DaemonClient;

    const model = new BridgeModel(client, () => {});
    await model.load();

    expect(fetchOptions).toMatchObject({ subscribe: {}, filter: { includeArchived: true } });
    const shells = model.shellSnapshot().threads;
    expect(shells).toHaveLength(1);
    expect(shells[0]?.archivedAt).toBe("2026-11-06T01:00:00.000Z");
  });

  it("pins threads from their workspace and follows workspace updates", async () => {
    const eventHandlers: Array<(event: unknown) => void> = [];
    const entry = makeEntry(null);
    (entry.agent as { workspaceId?: string }).workspaceId = "wks_1";
    const client = {
      listProjects: async () => ({ projects: [] }),
      fetchWorkspaces: async () => ({ entries: [{ id: "wks_1", pinnedAt: AT }] }),
      fetchAgents: async () => ({ entries: [entry] }),
      subscribe: (handler: (event: unknown) => void) => {
        eventHandlers.push(handler);
        return () => {};
      },
    } as unknown as DaemonClient;

    const model = new BridgeModel(client, () => {});
    await model.load();
    expect(model.shellSnapshot().threads[0]?.isPinned).toBe(true);

    eventHandlers[0]?.({
      type: "workspace_update",
      workspaceId: "wks_1",
      payload: { kind: "upsert", workspace: { id: "wks_1", pinnedAt: null } },
    });
    expect(model.shellSnapshot().threads[0]?.isPinned).toBe(false);

    // The pin write path refreshes the shell without waiting for a daemon event.
    model.noteWorkspacePinned("wks_1", AT);
    expect(model.shellSnapshot().threads[0]?.isPinned).toBe(true);

    model.notePrStatus("/repo", {
      number: 7,
      title: "Add a feature",
      url: "https://github.com/neolix/neolix/pull/7",
      baseBranch: "main",
      headBranch: "feature",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: null,
      deletions: null,
      changedFiles: null,
    });
    expect(model.shellSnapshot().threads[0]?.lastKnownPr).toMatchObject({ number: 7 });
  });

  it("restores the worktree shell for an agent created with a bare worktree cwd", async () => {
    const entry = makeEntry(null);
    (entry.agent as { cwd?: string }).cwd = "/home/.neox/worktrees/hash/synara-1";
    const client = {
      listProjects: async () => ({ projects: [] }),
      fetchWorkspaces: async () => ({
        entries: [
          {
            id: "wks_1",
            workspaceKind: "worktree",
            workspaceDirectory: "/home/.neox/worktrees/hash/synara-1",
            gitRuntime: { currentBranch: "synara/1" },
          },
        ],
      }),
      fetchAgents: async () => ({ entries: [entry] }),
      subscribe: () => () => {},
    } as unknown as DaemonClient;

    const model = new BridgeModel(client, () => {});
    await model.load();

    const shell = model.shellSnapshot().threads[0];
    expect(shell?.envMode).toBe("worktree");
    expect(shell?.worktreePath).toBe("/home/.neox/worktrees/hash/synara-1");
    expect(shell?.branch).toBe("synara/1");
  });

  it("serves a fork's imported transcript ahead of the draft and tracks its workspace", async () => {
    const client = { subscribe: () => () => {} } as unknown as DaemonClient;
    const model = new BridgeModel(client, () => {});
    const shell = {
      id: "fork-1",
      projectId: "prj_1",
      title: "Fork",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: "/repo",
      latestTurn: null,
      createdAt: AT,
      updatedAt: AT,
      handoff: null,
      session: null,
    } as unknown as Parameters<BridgeModel["registerDraft"]>[0];
    model.registerDraft(shell);
    model.setImportedTranscript("fork-1", [
      {
        id: "imported-1",
        role: "user",
        text: "Earlier",
        turnId: null,
        streaming: false,
        source: "fork-import",
        createdAt: AT,
        updatedAt: AT,
      } as never,
    ]);
    expect(model.importedTranscript("fork-1")).toHaveLength(1);
    const detail = await model.threadDetail("fork-1");
    expect(detail?.thread.messages.map((message) => message.source)).toEqual(["fork-import"]);

    model.updateDraftWorkspace("fork-1", {
      envMode: "worktree",
      branch: "feature",
      worktreePath: "/repo-wt",
    });
    expect(model.shellSnapshot().threads[0]).toMatchObject({
      envMode: "worktree",
      branch: "feature",
      worktreePath: "/repo-wt",
    });
  });

  it("reads project pins from the bridge store on load and on reload", async () => {
    const client = {
      listProjects: async () => ({
        projects: [
          { projectId: "prj_1", projectDisplayName: "one", projectRootPath: "/one" },
          { projectId: "prj_2", projectDisplayName: "two", projectRootPath: "/two" },
        ],
      }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async () => ({ entries: [] }),
      subscribe: () => () => {},
    } as unknown as DaemonClient;
    const pinned = new Set(["prj_1"]);
    const model = new BridgeModel(client, () => {}, undefined, {
      isPinned: (projectId) => pinned.has(projectId),
    });
    await model.load();
    const pins = () =>
      Object.fromEntries(
        model.shellSnapshot().projects.map((project) => [project.id, project.isPinned]),
      );
    expect(pins()).toEqual({ prj_1: true, prj_2: false });

    pinned.add("prj_2");
    await model.reloadProjects();
    expect(pins()).toEqual({ prj_1: true, prj_2: true });
  });

  it("resolves a client-minted project id to the daemon project it created", async () => {
    const client = {
      listProjects: async () => ({
        projects: [
          { projectId: "prj_home", projectDisplayName: "me", projectRootPath: "/home/me" },
        ],
      }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async () => ({ entries: [] }),
      subscribe: () => () => {},
    } as unknown as DaemonClient;
    const model = new BridgeModel(client, () => {}, "/home/me");
    await model.load();
    expect(model.shellSnapshot().projects[0]?.kind).toBe("chat");

    model.aliasProject("client-project", "prj_home");
    expect(model.projectRoot("client-project")).toBe("/home/me");
    model.registerDraft({
      id: "draft-1",
      projectId: "client-project",
      title: "Chat",
    } as unknown as Parameters<BridgeModel["registerDraft"]>[0]);
    expect(model.draft("draft-1")?.projectId).toBe("prj_home");
    expect(model.resolveProjectId("prj_other")).toBe("prj_other");
  });

  it("settles a closed thread's cached turn from its agent without reading the timeline", async () => {
    const entry = makeEntry(null);
    (entry.agent as { status: string }).status = "running";
    const agentId = entry.agent.id;
    const eventHandlers: Array<(event: unknown) => void> = [];
    let timelineReads = 0;
    const client = {
      listProjects: async () => ({ projects: [] }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async () => ({ entries: [entry] }),
      // Reading a stored agent's timeline makes the daemon resume it, so only an opened
      // thread may read it.
      fetchAgentTimeline: async () => {
        timelineReads += 1;
        return {
          entries: [
            {
              seqStart: 7,
              timestamp: AT,
              item: { type: "user_message", messageId: "u1", text: "go" },
            },
          ],
        };
      },
      subscribe: (handler: (event: unknown) => void) => {
        eventHandlers.push(handler);
        return () => {};
      },
    } as unknown as DaemonClient;
    const model = new BridgeModel(client, () => {});
    await model.load();
    expect(timelineReads).toBe(0);
    expect(model.shellSnapshot().threads[0]?.latestTurn).toBeNull();

    await model.threadDetail(agentId);
    expect(model.shellSnapshot().threads[0]?.latestTurn).toMatchObject({
      turnId: `turn:${agentId}:7`,
      state: "running",
      completedAt: null,
    });

    const settledAt = "2026-11-05T05:29:00.000Z";
    eventHandlers[0]?.({
      type: "agent_update",
      payload: { kind: "upsert", agent: { ...entry.agent, status: "idle", updatedAt: settledAt } },
    });
    expect(model.shellSnapshot().threads[0]?.latestTurn).toMatchObject({
      turnId: `turn:${agentId}:7`,
      state: "completed",
      completedAt: settledAt,
    });

    eventHandlers[0]?.({
      type: "agent_update",
      payload: { kind: "upsert", agent: { ...entry.agent, status: "error", updatedAt: settledAt } },
    });
    expect(model.shellSnapshot().threads[0]?.latestTurn?.state).toBe("completed");
    eventHandlers[0]?.({
      type: "agent_update",
      payload: { kind: "upsert", agent: { ...entry.agent, status: "running" } },
    });
    expect(model.shellSnapshot().threads[0]?.latestTurn).toMatchObject({
      state: "running",
      completedAt: null,
    });
    expect(timelineReads).toBe(1);
  });

  it("keeps drafts across a bridge restart until they get an agent", async () => {
    type Shell = Parameters<BridgeModel["registerDraft"]>[0];
    const shell = (id: string, extra: Record<string, unknown> = {}) =>
      ({
        id,
        projectId: "prj_1",
        title: "新终端",
        createdAt: AT,
        updatedAt: AT,
        ...extra,
      }) as unknown as Shell;
    let stored: readonly Shell[] = [];
    const store = {
      load: async () => stored,
      save: async (drafts: readonly Shell[]) => {
        stored = drafts;
      },
    };
    const eventHandlers: Array<(event: unknown) => void> = [];
    const client = {
      listProjects: async () => ({
        projects: [{ projectId: "prj_1", projectDisplayName: "repo", projectRootPath: "/repo" }],
      }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async () => ({ entries: [] }),
      subscribe: (handler: (event: unknown) => void) => {
        eventHandlers.push(handler);
        return () => {};
      },
    } as unknown as DaemonClient;
    const entry = makeEntry(null);
    const agentId = entry.agent.id;

    const first = new BridgeModel(client, () => {}, undefined, undefined, store);
    await first.load();
    first.registerDraft(shell("terminal-1"));
    first.registerDraft(shell(agentId));
    // A fork needs its in-memory transcript, so it is not saved.
    first.registerDraft(shell("fork-1", { forkSourceThreadId: agentId }));
    expect(stored.map((draft) => draft.id)).toEqual(["terminal-1", agentId]);
    stored = [...stored, shell("orphan", { projectId: "prj_removed" })];

    const restarted = new BridgeModel(client, () => {}, undefined, undefined, store);
    await restarted.load();
    expect(restarted.draft("terminal-1")?.title).toBe("新终端");
    expect(restarted.shellSnapshot().threads.map((thread) => thread.id)).toEqual([
      "terminal-1",
      agentId,
    ]);
    // A draft whose project is gone is dropped from the file too.
    expect(stored.map((draft) => draft.id)).toEqual(["terminal-1", agentId]);

    // A draft's rename is saved with it.
    restarted.renameDraft("terminal-1", " 构建终端 ");
    expect(restarted.draft("terminal-1")?.title).toBe("构建终端");
    expect(stored.find((draft) => draft.id === "terminal-1")?.title).toBe("构建终端");

    // The first turn creates the agent; the daemon lists it from then on.
    eventHandlers.at(-1)?.({
      type: "agent_update",
      payload: { kind: "upsert", agent: entry.agent, project: null },
    });
    expect(stored.map((draft) => draft.id)).toEqual(["terminal-1"]);
    expect(restarted.discardDraft("terminal-1")).toBe(true);
    expect(stored).toEqual([]);
  });

  it("tells whether an agent is alone in its workspace", async () => {
    const first = makeEntry(null);
    (first.agent as { workspaceId?: string }).workspaceId = "wks_shared";
    const second = makeEntry(null);
    (second.agent as { id: string; workspaceId?: string }).id = "second-agent";
    (second.agent as { workspaceId?: string }).workspaceId = "wks_shared";
    const client = {
      listProjects: async () => ({ projects: [] }),
      fetchWorkspaces: async () => ({ entries: [] }),
      fetchAgents: async () => ({ entries: [first, second] }),
      subscribe: () => () => {},
    } as unknown as DaemonClient;
    const model = new BridgeModel(client, () => {});
    await model.load();
    expect(model.isSoleWorkspaceAgent(first.agent.id, "wks_shared")).toBe(false);
    expect(model.isSoleWorkspaceAgent(first.agent.id, "wks_own")).toBe(true);
  });
});
