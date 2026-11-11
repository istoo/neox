// FILE: workspacePaletteCommands.ts
// Purpose: Builds the command palette's current-workspace commands: git actions published by
//          the header control, workspace panels, open-tab navigation, split-pane commands, and
//          layout toggles. Every row reuses an existing handler or store; nothing is re-implemented.
// Layer: UI commands
// Exports: buildWorkspacePaletteActions

import type { ProjectId, ThreadId } from "@synara/contracts";

import type { SidebarSearchAction } from "./components/SidebarSearchPalette.logic";
import { getNextVisibleSidebarThreadId } from "./components/Sidebar.logic";
import { getRightDockPaneMeta } from "./components/chat/rightDockPaneMeta";
import { useGitCommandPaletteStore } from "./gitCommandPaletteStore";
import { cycleThemeMode } from "./hooks/useTheme";
import { t } from "./i18n";
import { useRightDockStore, selectRightDockState } from "./rightDockStore";
import { findDirectionalNeighbor, collectLeaves, findLeafPaneById } from "./splitView.logic";
import {
  type PaneId,
  type SplitPanePanel,
  type SplitViewId,
  resolveSplitViewThreadIds,
  useSplitViewStore,
} from "./splitViewStore";
import { useWorkspaceFocusModeStore } from "./workspaceFocusModeStore";

export interface WorkspacePaletteInput {
  activeThreadId: ThreadId | null;
  activeProjectId: ProjectId | null;
  isProjectPinned: boolean;
  openThreadTabIds: readonly ThreadId[];
  onTogglePinProject: (projectId: ProjectId) => void;
  onToggleLeftSidebar: () => void;
  onActivateThreadTab: (threadId: ThreadId) => void;
  onRenameActiveThread: () => void;
  onCloseActiveThreadTab: () => void;
  /** Route handoff after a split view is created or reopened. */
  onOpenSplitView: (splitViewId: SplitViewId, threadId: ThreadId) => void;
}

function openDockPane(threadId: ThreadId, kind: SplitPanePanel | "git"): void {
  const store = useRightDockStore.getState();
  const state = selectRightDockState(threadId)(store);
  const existing = state.panes.find((pane) => pane.kind === kind);
  if (existing) {
    store.setActivePane(threadId, existing.id);
    store.setDockOpen(threadId, true);
    return;
  }
  store.openPane(threadId, { kind });
}

function findSplitViewIdForThread(threadId: ThreadId): SplitViewId | null {
  const store = useSplitViewStore.getState();
  const direct = store.splitViewIdBySourceThreadId[threadId];
  if (direct) return direct;
  for (const [splitViewId, splitView] of Object.entries(store.splitViewsById)) {
    if (splitView && resolveSplitViewThreadIds(splitView).includes(threadId)) {
      return splitViewId;
    }
  }
  return null;
}

// Opens `panel` as a leaf's whole content. Creates the split from a single chat when
// none exists, reuses an existing panel leaf, and otherwise splits the focused pane.
function openPanelInSplitPane(input: {
  threadId: ThreadId;
  projectId: ProjectId | null;
  panel: SplitPanePanel;
  onOpenSplitView: WorkspacePaletteInput["onOpenSplitView"];
}): void {
  const store = useSplitViewStore.getState();
  let splitViewId = findSplitViewIdForThread(input.threadId);
  let targetPaneId: PaneId | null = null;

  if (!splitViewId) {
    if (!input.projectId) return;
    splitViewId = store.createFromThread({
      sourceThreadId: input.threadId,
      ownerProjectId: input.projectId,
    });
  }

  const splitView = useSplitViewStore.getState().splitViewsById[splitViewId];
  if (!splitView) return;
  const existingPanel = collectLeaves(splitView.root).find(
    (leaf) => leaf.content?.kind === "panel" && leaf.content.panel === input.panel,
  );
  if (existingPanel) {
    store.setFocusedPane(splitViewId, existingPanel.id);
    targetPaneId = existingPanel.id;
  } else {
    const focused = findLeafPaneById(splitView.root, splitView.focusedPaneId);
    if (focused && focused.content === undefined && focused.threadId === null) {
      targetPaneId = focused.id;
    } else {
      targetPaneId = store.splitPaneInSplitView({
        splitViewId,
        paneId: splitView.focusedPaneId,
        direction: "horizontal",
        side: "second",
      });
    }
  }
  if (!targetPaneId) return;
  const targetLeaf = findLeafPaneById(
    useSplitViewStore.getState().splitViewsById[splitViewId]?.root ?? splitView.root,
    targetPaneId,
  );
  if (!targetLeaf) return;
  // A panel leaf still needs a host thread for its project, worktree, and terminal
  // scope. An empty pane gets the thread the command ran from.
  if (targetLeaf.threadId === null) {
    useSplitViewStore.getState().replacePaneThread(splitViewId, targetPaneId, input.threadId);
  }
  useSplitViewStore
    .getState()
    .setPaneContent(splitViewId, targetPaneId, { kind: "panel", panel: input.panel });
  input.onOpenSplitView(splitViewId, input.threadId);
}

function buildPanelActions(
  input: WorkspacePaletteInput,
  threadId: ThreadId,
): SidebarSearchAction[] {
  const dockKinds: readonly (SplitPanePanel | "git")[] = [
    "terminal",
    "browser",
    "diff",
    "explorer",
    "git",
  ];
  const splitKinds: readonly SplitPanePanel[] = ["terminal", "browser", "diff", "explorer"];
  return [
    ...dockKinds.map((kind) => {
      const label = getRightDockPaneMeta(kind).label;
      return {
        id: `workspace-panel:${kind}`,
        label: t("workspace:palette_openPanel", { value0: label }),
        description: t("workspace:palette_openPanelDescription"),
        keywords: ["panel", "open", kind],
        requiresQuery: true,
        run: () => openDockPane(threadId, kind),
      };
    }),
    // A split needs the thread's project to mint the split view; without one the
    // command could only fail, so it is not listed.
    ...(input.activeProjectId
      ? splitKinds.map((kind) => {
          const label = getRightDockPaneMeta(kind).label;
          return {
            id: `workspace-panel-split:${kind}`,
            label: t("workspace:palette_openInSplitPane", { value0: label }),
            description: t("workspace:palette_openInSplitPaneDescription"),
            keywords: ["panel", "split", "pane", kind],
            requiresQuery: true,
            run: () =>
              openPanelInSplitPane({
                threadId,
                projectId: input.activeProjectId,
                panel: kind,
                onOpenSplitView: input.onOpenSplitView,
              }),
          };
        })
      : []),
  ];
}

function buildTabActions(input: WorkspacePaletteInput): SidebarSearchAction[] {
  const activeThreadId = input.activeThreadId;
  if (!activeThreadId) return [];
  const tabs = input.openThreadTabIds;
  const switchActions: SidebarSearchAction[] =
    tabs.length <= 1
      ? []
      : [
          {
            id: "workspace-tab:next",
            label: t("workspace:palette_nextTab"),
            description: t("workspace:palette_switchOpenTabs"),
            keywords: ["tab", "next", "switch"],
            requiresQuery: true,
            run: () => {
              const next = getNextVisibleSidebarThreadId({
                visibleThreadIds: tabs,
                activeThreadId,
                direction: "forward",
              });
              if (next) input.onActivateThreadTab(next);
            },
          },
          {
            id: "workspace-tab:previous",
            label: t("workspace:palette_previousTab"),
            description: t("workspace:palette_switchOpenTabs"),
            keywords: ["tab", "previous", "switch"],
            requiresQuery: true,
            run: () => {
              const next = getNextVisibleSidebarThreadId({
                visibleThreadIds: tabs,
                activeThreadId,
                direction: "backward",
              });
              if (next) input.onActivateThreadTab(next);
            },
          },
        ];
  return [
    ...switchActions,
    {
      id: "workspace-tab:rename",
      label: t("workspace:palette_renameTab"),
      description: t("workspace:palette_renameTabDescription"),
      keywords: ["tab", "rename", "title"],
      requiresQuery: true,
      run: input.onRenameActiveThread,
    },
    {
      id: "workspace-tab:close",
      label: t("workspace:palette_closeTab"),
      description: t("workspace:palette_closeTabDescription"),
      keywords: ["tab", "close"],
      requiresQuery: true,
      run: input.onCloseActiveThreadTab,
    },
  ];
}

function buildSplitActions(input: WorkspacePaletteInput): SidebarSearchAction[] {
  const threadId = input.activeThreadId;
  if (!threadId) return [];
  const store = useSplitViewStore.getState();
  const splitViewId = findSplitViewIdForThread(threadId);
  const splitView = splitViewId ? store.splitViewsById[splitViewId] : undefined;
  const maximized =
    splitView !== undefined && splitView.maximizedPaneId === splitView.focusedPaneId;

  const splitRow = (
    id: string,
    label: string,
    direction: "horizontal" | "vertical",
    side: "first" | "second",
  ): SidebarSearchAction => ({
    id,
    label,
    description: t("workspace:palette_splitPaneDescription"),
    keywords: ["split", "pane", "workspace"],
    requiresQuery: true,
    run: () => {
      if (!input.activeProjectId) return;
      const existingSplitViewId = findSplitViewIdForThread(threadId);
      // From a single chat the command opens the split itself; doing both would
      // create two empty panes from one keystroke.
      if (!existingSplitViewId) {
        const created = useSplitViewStore.getState().createFromThread({
          sourceThreadId: threadId,
          ownerProjectId: input.activeProjectId,
        });
        input.onOpenSplitView(created, threadId);
        return;
      }
      const current = useSplitViewStore.getState().splitViewsById[existingSplitViewId];
      if (!current) return;
      useSplitViewStore.getState().splitPaneInSplitView({
        splitViewId: existingSplitViewId,
        paneId: current.focusedPaneId,
        direction,
        side,
      });
      input.onOpenSplitView(existingSplitViewId, threadId);
    },
  });

  const moveRows = (
    [
      ["pane-move:left", "left", "workspace:palette_moveTabLeft"],
      ["pane-move:right", "right", "workspace:palette_moveTabRight"],
      ["pane-move:up", "up", "workspace:palette_moveTabUp"],
      ["pane-move:down", "down", "workspace:palette_moveTabDown"],
    ] as const
  ).map(([id, direction, labelKey]) => ({
    id: `workspace-${id}`,
    label: t(labelKey),
    description: t("workspace:palette_moveTabDescription"),
    keywords: ["pane", "tab", "move", direction],
    requiresQuery: true,
    run: () => {
      const currentSplitViewId = findSplitViewIdForThread(threadId);
      if (!currentSplitViewId) return;
      const current = useSplitViewStore.getState().splitViewsById[currentSplitViewId];
      if (!current) return;
      const neighbor = findDirectionalNeighbor(current.root, current.focusedPaneId, direction);
      if (!neighbor) return;
      useSplitViewStore.getState().movePaneContent({
        splitViewId: currentSplitViewId,
        fromPaneId: current.focusedPaneId,
        toPaneId: neighbor.id,
      });
      input.onOpenSplitView(currentSplitViewId, threadId);
    },
  }));

  const actions: SidebarSearchAction[] = [
    splitRow("workspace-split:right", t("workspace:palette_splitRight"), "horizontal", "second"),
    splitRow("workspace-split:down", t("workspace:palette_splitDown"), "vertical", "second"),
  ];
  // Moving and maximizing act on an existing split; listing them on a single chat
  // would put two rows in the palette that do nothing.
  if (!splitViewId) return actions;
  actions.push(...moveRows, {
    id: "workspace-pane:maximize",
    label: maximized ? t("workspace:palette_restorePane") : t("workspace:palette_maximizePane"),
    description: t("workspace:palette_maximizePaneDescription"),
    keywords: ["pane", "maximize", "focus", "zen"],
    requiresQuery: true,
    run: () => {
      const currentSplitViewId = findSplitViewIdForThread(threadId);
      if (!currentSplitViewId) return;
      const current = useSplitViewStore.getState().splitViewsById[currentSplitViewId];
      if (!current) return;
      useSplitViewStore
        .getState()
        .setMaximizedPane(
          currentSplitViewId,
          current.maximizedPaneId === current.focusedPaneId ? null : current.focusedPaneId,
        );
    },
  });
  return actions;
}

export function buildWorkspacePaletteActions(input: WorkspacePaletteInput): SidebarSearchAction[] {
  const actions: SidebarSearchAction[] = [];
  const threadId = input.activeThreadId;
  const projectId = input.activeProjectId;

  if (threadId) {
    actions.push(
      ...buildTabActions(input),
      ...buildSplitActions(input),
      ...buildPanelActions(input, threadId),
    );
    const gitCommands = useGitCommandPaletteStore.getState().commandsByThreadId[threadId] ?? [];
    for (const command of gitCommands) {
      actions.push({
        id: `git-action:${command.id}`,
        label: command.label,
        description: t("workspace:palette_gitActionDescription"),
        keywords: ["git", command.id],
        requiresQuery: true,
        run: command.run,
      });
    }
  }

  if (projectId) {
    actions.push({
      id: "workspace-project:pin",
      label: input.isProjectPinned
        ? t("workspace:palette_unpinProject")
        : t("workspace:palette_pinProject"),
      description: t("workspace:palette_pinProjectDescription"),
      keywords: ["pin", "unpin", "project", "favorite"],
      requiresQuery: true,
      run: () => input.onTogglePinProject(projectId),
    });
  }

  actions.push(
    {
      id: "workspace-layout:focus-mode",
      label: t("workspace:palette_focusMode"),
      description: t("workspace:palette_focusModeDescription"),
      keywords: ["focus", "zen", "sidebar", "layout"],
      run: () => useWorkspaceFocusModeStore.getState().toggle(),
    },
    {
      id: "workspace-layout:left-sidebar",
      label: t("workspace:palette_toggleLeftSidebar"),
      description: t("workspace:palette_toggleLeftSidebarDescription"),
      keywords: ["sidebar", "left", "toggle"],
      run: input.onToggleLeftSidebar,
    },
    {
      id: "workspace-layout:theme",
      label: t("workspace:palette_cycleTheme"),
      description: t("workspace:palette_cycleThemeDescription"),
      keywords: ["theme", "appearance", "light", "dark"],
      run: cycleThemeMode,
    },
  );

  // The split surface renders panels inside panes and no dock, so the toggle has
  // nothing to show there; leave it out rather than list a row that looks inert.
  if (threadId && !findSplitViewIdForThread(threadId)) {
    actions.push({
      id: "workspace-layout:right-sidebar",
      label: t("workspace:palette_toggleRightSidebar"),
      description: t("workspace:palette_toggleRightSidebarDescription"),
      keywords: ["sidebar", "right", "dock", "panel", "toggle"],
      run: () => {
        const store = useRightDockStore.getState();
        const state = selectRightDockState(threadId)(store);
        store.setDockOpen(threadId, !state.open);
      },
    });
  }

  return actions;
}
