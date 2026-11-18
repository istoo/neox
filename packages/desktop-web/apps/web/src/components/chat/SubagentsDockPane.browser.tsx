import "../../index.css";
import { ProjectId, ThreadId } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { collectLeaves } from "../../splitView.logic";
import { useSplitViewStore } from "../../splitViewStore";
import { useRightDockStore } from "../../rightDockStore";
import { toastManager } from "../ui/toast";
import {
  runningSubagentRosterItem,
  subagentRosterItem,
} from "./environment/subagentRosterFixtures";
import { SubagentsDockPane, SubagentsList } from "./SubagentsDockPane";
import { SplitChatSurface } from "./SplitChatSurface";

const state = vi.hoisted(() => ({
  navigate: vi.fn(async (_input: unknown) => {}),
  dispatch: vi.fn(async (_input: unknown) => {}),
  detach: vi.fn(async (_input: unknown) => {}),
  roster: { active: [] as unknown[], previous: [] as unknown[] },
  managedThreadIds: new Set<string>(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../../nativeApi", async (importOriginal) => {
  // Keep the module's other exports (capability listeners and the like) real.
  const api = {
    orchestration: { dispatchCommand: state.dispatch },
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
    serverVersion: "0.15.0",
    features: { agentDetach: true },
  }),
}));
vi.mock("./useSubagentStripSource", () => ({
  useThreadSubagentRoster: () => ({
    roster: state.roster,
    source: { stripSourceThreadId: "parent", subagentParentRow: null },
    managedThreadIds: state.managedThreadIds,
  }),
}));
vi.mock("../../hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: vi.fn() }),
}));
vi.mock("../../hooks/useBrowserPanelDesktopBridge", () => ({
  useBrowserPanelDesktopBridge: () => {},
}));
vi.mock("./ChatPaneKeepAlive", () => ({
  KeptChatPane: ({ children }: { children: ReactNode }) => children,
  ChatPaneBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ChatThreadSurfacePrimitives", () => ({
  DeferredChatView: () => <div>Transcript</div>,
  ChatMountLoader: () => null,
  LazyBrowserPanel: () => null,
  LazyDiffPanel: () => null,
  noopChatSurfaceAction: () => {},
}));
const parent = ThreadId.makeUnsafe("parent");
const other = ThreadId.makeUnsafe("other");
const child = runningSubagentRosterItem("Scout", { modelLabel: "Opus 5.5 · high" });

// The dock queries provider subagents; the app always mounts it under a QueryClientProvider.
function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.roster = { active: [child], previous: [] };
  // Activity-derived rows are provider task handles, not Neox child agents.
  state.managedThreadIds = new Set<string>();
  useRightDockStore.setState({ dockStateByThreadId: {} });
});

it("expands and collapses finished rows without leaving hidden buttons reachable", async () => {
  const screen = await renderWithQuery(
    <SubagentsList
      roster={{
        active: [child],
        previous: Array.from({ length: 12 }, (_, i) =>
          subagentRosterItem(`Done ${i}`, { modelLabel: i === 0 ? "GPT-5.5 · high" : undefined }),
        ),
      }}
      parent={null}
      nowMs={0}
      onOpen={() => {}}
      onStop={() => {}}
      onBackground={() => {}}
    />,
  );
  try {
    await expect
      .element(page.getByText("Running · Opus 5.5 · high", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("GPT-5.5 · high", { exact: true })).toBeVisible();
    const extra = page.getByRole("button", { name: "Open subagent Done 11 (Completed)" });
    expect(extra.elements()).toHaveLength(0);
    await page.getByRole("button", { name: "Show 2 more" }).click();
    await expect.element(extra).toBeVisible();
    await page.getByRole("button", { name: "Show less" }).click();
    expect(extra.elements()).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});

it.each(["Stop subagent Scout", "Run Scout in background"])(
  "reports rejected %s commands",
  async (label) => {
    state.dispatch.mockRejectedValueOnce(new Error("Provider disconnected"));
    const feedback = vi.spyOn(toastManager, "add");
    const screen = await renderWithQuery(<SubagentsDockPane hostThreadId={parent} />);
    try {
      page.getByRole("button", { name: "Open subagent Scout (Running)" }).element().focus();
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect.poll(() => feedback.mock.calls.length).toBe(1);
      expect(feedback.mock.calls[0]?.[0]).toMatchObject({
        type: "error",
        description: "Provider disconnected",
      });
    } finally {
      feedback.mockRestore();
      await screen.unmount();
    }
  },
);

it("detaches a managed child agent after confirmation and opens it", async () => {
  // Detach addresses a real Neox agent id, so the dock must know the row is a child agent.
  state.managedThreadIds = new Set([String(child.threadId)]);
  const screen = await renderWithQuery(<SubagentsDockPane hostThreadId={parent} />);
  try {
    page.getByRole("button", { name: "Open subagent Scout (Running)" }).element().focus();
    await page.getByRole("button", { name: "Detach subagent Scout", exact: true }).click();
    await expect.element(page.getByText("will leave this track", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Detach", exact: true }).click();
    await expect.poll(() => state.detach.mock.calls.length).toBe(1);
    expect(state.detach).toHaveBeenCalledWith({ agentId: child.threadId });
    await expect.poll(() => state.navigate.mock.calls.length).toBe(1);
  } finally {
    await screen.unmount();
  }
});

it("opens the subagent dock in a split pane, keeps its destination in that pane, and closes it", async () => {
  await page.viewport(1800, 1000);
  const split = useSplitViewStore.getState().createFromDrop({
    sourceThreadId: parent,
    ownerProjectId: ProjectId.makeUnsafe("project"),
    droppedThreadId: other,
    direction: "horizontal",
    side: "second",
  });
  const sourcePane = collectLeaves(useSplitViewStore.getState().splitViewsById[split]!.root).find(
    (leaf) => leaf.threadId === parent,
  )!;
  useRightDockStore.getState().openPane(parent, { kind: "subagents" });
  const screen = await renderWithQuery(
    <SplitChatSurface splitViewId={split} routeThreadId={parent} />,
  );
  try {
    await expect
      .element(page.getByRole("button", { name: "Open subagent Scout (Running)" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Open subagent Scout (Running)" }).click();
    await expect
      .poll(
        () =>
          collectLeaves(useSplitViewStore.getState().splitViewsById[split]!.root).find(
            (leaf) => leaf.id === sourcePane.id,
          )?.threadId,
      )
      .toBe(child.threadId);
    expect(state.navigate.mock.calls.at(-1)?.[0]).toMatchObject({
      params: { threadId: child.threadId },
    });
    await page.getByRole("button", { name: "Hide subagents", exact: true }).click();
    await expect
      .poll(
        () => page.getByRole("button", { name: "Open subagent Scout (Running)" }).elements().length,
      )
      .toBe(0);
  } finally {
    await screen.unmount();
    useSplitViewStore.getState().removeSplitView(split);
  }
});

it("keeps completed-only relative time current after the last active run settles", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let nowMs = Date.parse("2026-10-10T10:01:10Z");
  const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  state.roster = { active: [], previous: [subagentRosterItem("Finished")] };
  const screen = await renderWithQuery(<SubagentsDockPane hostThreadId={parent} />);
  try {
    await expect.element(page.getByText("just now", { exact: true })).toBeVisible();
    nowMs += 120_000;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect.element(page.getByText("2m ago", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
    vi.useRealTimers();
    clock.mockRestore();
  }
});

it("reveals gated dock controls through keyboard row focus before Stop is clickable", async () => {
  const screen = await renderWithQuery(
    <>
      <button>Focus start</button>
      <SubagentsDockPane hostThreadId={parent} />
    </>,
  );
  try {
    const start = page.getByRole("button", { name: "Focus start", exact: true });
    await start.hover();
    start.element().focus();
    const stop = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop subagent Scout"]',
    )!;
    expect(getComputedStyle(stop).visibility).toBe("hidden");
    const controls = stop.closest<HTMLElement>(".pointer-events-none")!;
    expect(getComputedStyle(controls).pointerEvents).toBe("none");
    const row = page.getByRole("button", { name: "Open subagent Scout (Running)" }).element();
    for (let i = 0; i < 8 && document.activeElement !== row; i++) await userEvent.tab();
    expect(document.activeElement).toBe(row);
    await expect.poll(() => getComputedStyle(stop).visibility).toBe("visible");
    await page.getByRole("button", { name: "Stop subagent Scout", exact: true }).click();
    expect(state.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.interrupt" }),
    );
  } finally {
    await screen.unmount();
  }
});
