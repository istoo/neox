import "../../index.css";
import { ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import type { ThreadSession, ThreadShell } from "../../types";
import { SubagentsDockPane } from "./SubagentsDockPane";

const state = vi.hoisted(() => ({
  navigate: vi.fn(async (_input: unknown) => {}),
  detach: vi.fn(async (_input: unknown) => {}),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../nativeApi", async (importOriginal) => {
  const api = {
    orchestration: { dispatchCommand: async () => {} },
    neolix: {
      subagents: {
        list: async () => ({ subagents: [] }),
        detach: state.detach,
      },
    },
  };
  return {
    ...(await importOriginal<typeof import("../../nativeApi")>()),
    readNativeApi: () => api,
    ensureNativeApi: () => api,
  };
});
vi.mock("../../lib/neolixHostApi", () => ({
  getHostFeatures: async () => ({
    serverVersion: "0.17.0",
    features: { agentDetach: true },
  }),
}));

const parentId = ThreadId.makeUnsafe("parent-agent");
const childId = ThreadId.makeUnsafe("child-agent");
const at = "2026-10-10T10:00:00.000Z";

const parentShell = {
  id: parentId,
  title: "Parent",
  projectId: ProjectId.makeUnsafe("project"),
  parentThreadId: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledAt: null,
  error: null,
  modelSelection: { provider: "claudeAgent", model: "Opus 5.5", instanceId: "claude" },
} as ThreadShell;

// A managed child created by `create_agent`: a real agent thread linked to its parent by
// the daemon's `neolix.parent-agent-id` label, with no collab activity of its own.
const childShell = {
  ...parentShell,
  id: childId,
  title: "Scout",
  parentThreadId: parentId,
  subagentNickname: "Kepler",
} as ThreadShell;

const session = {
  provider: "claudeAgent",
  status: "running",
  orchestrationStatus: "running",
  createdAt: at,
  updatedAt: at,
} as ThreadSession;

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    threadIds: [parentId, childId],
    threadShellById: {
      [parentId]: parentShell,
      [childId]: childShell,
    },
    threadSessionById: { [parentId]: null, [childId]: session },
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
  });
});

it("lists a managed child agent and detaches it by its agent id", async () => {
  const screen = await renderWithQuery(<SubagentsDockPane hostThreadId={parentId} />);
  try {
    const row = page.getByRole("button", { name: "Open subagent Kepler (Running)" });
    await expect.element(row).toBeVisible();

    row.element().focus();
    await page.getByRole("button", { name: "Detach subagent Kepler", exact: true }).click();
    await expect.element(page.getByText("will leave this track", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Detach", exact: true }).click();

    await expect.poll(() => state.detach.mock.calls.length).toBe(1);
    expect(state.detach).toHaveBeenCalledWith({ agentId: childId });
    await expect.poll(() => state.navigate.mock.calls.length).toBe(1);
  } finally {
    await screen.unmount();
  }
});
