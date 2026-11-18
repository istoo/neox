import { describe, expect, it } from "vitest";

import type { FetchAgentsEntry } from "../../../../client/dist/daemon-client.js";
import {
  ShellProjection,
  isMissingPathError,
  lifecycleText,
  projectConfigProjection,
} from "./shellProjection.ts";

const AT = "2026-11-05T05:27:06.873Z";

function makeEntry(agent: Record<string, unknown> = {}): FetchAgentsEntry {
  return {
    agent: {
      id: "agent-1",
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
      title: "Chat",
      labels: {},
      archivedAt: null,
      ...agent,
    },
    project: null,
  } as unknown as FetchAgentsEntry;
}

describe("project config projection", () => {
  it("keeps the dialog-compatible scripts and the worktree lifecycle commands", () => {
    const projection = projectConfigProjection({
      ok: true,
      config: {
        scripts: {
          ping: { command: "echo pong" },
          setup: { command: "bun install" },
          bad: { command: "   " },
        },
        worktree: { setup: ["bun install"], teardown: "rm -rf out" },
      },
    });
    expect(projection).not.toBeNull();
    expect(projection?.scripts).toEqual([
      { id: "ping", name: "ping", command: "echo pong", icon: "play", runOnWorktreeCreate: false },
      {
        id: "setup",
        name: "setup",
        command: "bun install",
        icon: "play",
        runOnWorktreeCreate: true,
      },
    ]);
    expect(projection?.worktree).toEqual({ setup: "bun install", teardown: "rm -rf out" });
  });

  it("returns null when the daemon could not read the file, so the last list stays", () => {
    expect(projectConfigProjection({ ok: false })).toBeNull();
  });

  it("normalizes lifecycle commands and recognises missing-path errors", () => {
    expect(lifecycleText(["bun install", "  ", "bun run build"])).toBe(
      "bun install\n  \nbun run build",
    );
    expect(lifecycleText("   ")).toBeNull();
    expect(lifecycleText(42)).toBeNull();
    expect(isMissingPathError(new Error("ENOENT: no such file or directory, realpath"))).toBe(true);
    expect(isMissingPathError(new Error("Connection closed"))).toBe(false);
  });
});

describe("ShellProjection", () => {
  it("folds workspace pins, forge status and the worktree registry into a thread shell", () => {
    const projection = new ShellProjection({});
    const entry = makeEntry({ cwd: "/repo/wt/app", workspaceId: "wks_1" });
    projection.setEntry(entry);
    projection.replaceWorkspaces([
      { id: "wks_1", pinnedAt: AT, directory: "/repo" },
      {
        id: "wks_2",
        directory: "/repo/wt",
        kind: "worktree",
        branch: "feature",
      },
    ]);

    const shell = projection.shellFor(entry, null);
    expect(shell.isPinned).toBe(true);
    expect(shell.envMode).toBe("worktree");
    expect(shell.worktreePath).toBe("/repo/wt");
    expect(shell.branch).toBe("feature");

    const pr = {
      number: 7,
      title: "Add a feature",
      url: "https://example.test/pr/7",
      baseBranch: "main",
      headBranch: "feature",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: null,
      deletions: null,
      changedFiles: null,
    } as const;
    expect(projection.notePrStatus("/repo/wt/app", pr)).toHaveLength(1);
    expect(projection.shellFor(entry, null).lastKnownPr).toMatchObject({ number: 7 });
    // Unchanged status does not republish the shell.
    expect(projection.notePrStatus("/repo/wt/app", pr)).toEqual([]);

    const unpinned = projection.noteWorkspacePinned("wks_1", null);
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]?.isPinned).toBe(false);
  });

  it("keeps a managed child agent and its parent link in the shell snapshot", () => {
    const projection = new ShellProjection({});
    const parent = makeEntry({ id: "parent-agent", title: "Parent" });
    const child = makeEntry({
      id: "child-agent",
      title: "Scout",
      labels: { "neolix.parent-agent-id": "parent-agent" },
    });
    projection.setEntry(parent);
    projection.setShell("parent-agent", projection.shellFor(parent, null));
    projection.setEntry(child);
    projection.setShell("child-agent", projection.shellFor(child, null));

    const threads = projection.shellSnapshot().threads;
    expect(threads.map((thread) => thread.id)).toEqual(["parent-agent", "child-agent"]);
    expect(threads[1]?.parentThreadId).toBe("parent-agent");
  });

  it("numbers shell items monotonically and projects project shells", () => {
    const projection = new ShellProjection({ homeDir: "/home/me" });
    projection.setProject(
      "home",
      projection.projectShell({
        projectId: "home",
        projectDisplayName: "me",
        projectRootPath: "/home/me",
      }),
    );
    expect(projection.shellSnapshot().projects[0]?.kind).toBe("chat");
    expect(projection.next()).toBe(1);
    expect(projection.next()).toBe(2);
  });

  it("republishes a project only when its missing-root state changes", () => {
    const projection = new ShellProjection({});
    projection.setProject(
      "p1",
      projection.projectShell({
        projectId: "p1",
        projectDisplayName: "repo",
        projectRootPath: "/repo",
      }),
    );
    expect(projection.applyRootMissing("p1", false)).toBeNull();
    expect(projection.applyRootMissing("p1", true)?.rootMissing).toBe(true);
    expect(projection.applyRootMissing("p1", true)).toBeNull();
    expect(projection.applyRootMissing("p1", false)?.rootMissing).toBeUndefined();
  });
});
