// FILE: DesktopOsIntegrationCoordinator.browser.tsx
// Purpose: `--open-project` paths either navigate to the existing project's latest
//          thread or create and open the project first.
// Layer: Browser UI test

import "../index.css";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  handleNewThread: vi.fn(async () => "thread-new"),
  createOrRecover: vi.fn(async (_input: unknown) => ({
    projectId: "prj-new",
    project: { id: "prj-new" },
    snapshot: null,
    created: true,
  })),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => harness.navigate,
}));

vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({
    settings: { defaultProvider: "codex", language: "system" },
    updateSettings: vi.fn(),
  }),
}));

vi.mock("~/hooks/useHandleNewThread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useHandleNewThread")>()),
  useHandleNewThread: () => ({ handleNewThread: harness.handleNewThread }),
}));

vi.mock("~/lib/projectCreation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/projectCreation")>()),
  createOrRecoverProjectFromPath: (input: unknown) => harness.createOrRecover(input),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({
    orchestration: { getShellSnapshot: async () => null },
  }),
}));

vi.mock("~/lib/neolixHostApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/neolixHostApi")>()),
  getHostStatus: async () => ({ serverId: "srv-1", version: "0.16.5", pid: 42 }),
}));

import { DesktopOsIntegrationCoordinator } from "./DesktopOsIntegrationCoordinator";
import { useStore } from "~/store";

function projectAt(id: string, cwd: string): Record<string, unknown> {
  return {
    id,
    kind: "git",
    name: id,
    remoteName: "",
    folderName: id,
    localName: null,
    cwd,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
  };
}

beforeEach(() => {
  harness.navigate.mockClear();
  harness.handleNewThread.mockClear();
  harness.createOrRecover.mockClear();
  (window as unknown as { neolixDesktop?: unknown }).neolixDesktop = {
    getPendingOpenProject: async () => "/repo/existing",
  };
});

afterEach(() => {
  delete (window as unknown as { neolixDesktop?: unknown }).neolixDesktop;
  useStore.setState({ projects: [], sidebarThreadSummaryById: {}, threadsHydrated: false });
});

it("navigates to the latest thread when the path is already a project", async () => {
  useStore.setState({
    threadsHydrated: true,
    projects: [projectAt("prj-1", "/repo/existing")] as never,
    sidebarThreadSummaryById: {
      "thread-1": {
        id: "thread-1",
        projectId: "prj-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    } as never,
  });

  render(<DesktopOsIntegrationCoordinator />);

  await vi.waitFor(() => {
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: "thread-1" },
    });
  });
  expect(harness.createOrRecover).not.toHaveBeenCalled();
});

it("creates the project and opens its first thread for a new path", async () => {
  (window as unknown as { neolixDesktop?: unknown }).neolixDesktop = {
    getPendingOpenProject: async () => "/repo/new",
  };
  useStore.setState({
    threadsHydrated: true,
    projects: [],
    sidebarThreadSummaryById: {},
  });

  render(<DesktopOsIntegrationCoordinator />);

  await vi.waitFor(() => {
    expect(harness.createOrRecover).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/repo/new" }),
    );
  });
  expect(harness.handleNewThread).toHaveBeenCalledWith("prj-new");
  await vi.waitFor(() => {
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: "thread-new" },
    });
  });
});
