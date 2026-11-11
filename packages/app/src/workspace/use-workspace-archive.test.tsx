/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
const archiveWorkspaceOptimistically = vi.hoisted(() => vi.fn());
const purgeWorkspace = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  workspaces: new Map<string, unknown>(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => toast }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({}) }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      sessions: { "server-1": { workspaces: sessionState.workspaces } },
    }),
  },
}));
vi.mock("@/git/worktree-archive-warning", () => ({
  confirmRiskyWorktreeArchive: vi.fn(async () => true),
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS: {},
}));
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: { getState: () => ({ purgeWorkspace }) },
}));
vi.mock("@/workspace-tabs/model", () => ({
  buildWorkspaceTabPersistenceKey: () => "server/workspace",
}));
vi.mock("@/workspace/workspace-archive", () => ({ archiveWorkspaceOptimistically }));

import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function archivedWorkspaceRecord(id: string): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/workspace",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}

function archiveInput(overrides: Record<string, unknown> = {}) {
  return {
    serverId: "server-1",
    workspaceId: "workspace-1",
    workspaceKind: "directory" as const,
    name: "workspace",
    onArchiveStarted: vi.fn(),
    onSetHiding: vi.fn(),
    ...overrides,
  };
}

describe("useWorkspaceArchive", () => {
  beforeEach(() => {
    toast.error.mockClear();
    archiveWorkspaceOptimistically.mockReset();
    purgeWorkspace.mockClear();
    sessionState.workspaces.clear();
  });

  it("navigates only after the daemon accepts the archive", async () => {
    const descriptor = archivedWorkspaceRecord("workspace-1");
    sessionState.workspaces.set("workspace-1", descriptor);
    let resolveArchive: () => void = () => {};
    archiveWorkspaceOptimistically.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveArchive = () => {
            sessionState.workspaces.delete("workspace-1");
            resolve();
          };
        }),
    );
    const input = archiveInput();
    const { result } = renderHook(() => useWorkspaceArchive(input));

    act(() => {
      result.current.archive();
    });

    expect(input.onArchiveStarted).not.toHaveBeenCalled();
    expect(input.onSetHiding).toHaveBeenCalledWith(true);

    await act(async () => {
      resolveArchive();
    });

    await waitFor(() => expect(input.onArchiveStarted).toHaveBeenCalledOnce());
    expect(input.onArchiveStarted).toHaveBeenCalledWith(descriptor);
    expect(input.onSetHiding).toHaveBeenLastCalledWith(false);
    expect(purgeWorkspace).toHaveBeenCalledWith("server/workspace");
  });

  it("keeps the current route and reports the failure when archiving fails", async () => {
    archiveWorkspaceOptimistically.mockRejectedValueOnce(new Error("archive rejected"));
    const input = archiveInput();
    const { result } = renderHook(() => useWorkspaceArchive(input));

    await act(async () => {
      result.current.archive();
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("archive rejected"));
    expect(input.onArchiveStarted).not.toHaveBeenCalled();
    expect(input.onSetHiding).toHaveBeenLastCalledWith(false);
    expect(purgeWorkspace).not.toHaveBeenCalled();
  });
});
