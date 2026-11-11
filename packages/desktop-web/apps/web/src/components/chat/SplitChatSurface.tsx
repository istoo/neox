import {
  type ProjectId,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  startTransition,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Schema } from "effect";

import { SplitPaneLayout } from "./SplitPaneLayout";
import { ProviderIcon } from "../ProviderIcon";
import { PanelStateMessage } from "./PanelStateMessage";
import {
  ChatMountLoader,
  DeferredChatView,
  LazyBrowserPanel,
  LazyDiffPanel,
  noopChatSurfaceAction,
} from "./ChatThreadSurfacePrimitives";
import { FloatingBrowserPanel } from "./FloatingBrowserPanel";
import { shouldRenderFloatingBrowserPanel } from "./floatingBrowserPanel.logic";
import { useFloatingBrowserRequestStore } from "./floatingBrowserRequestStore";
import { useBrowserPanelDesktopBridge } from "../../hooks/useBrowserPanelDesktopBridge";
import { useHandleNewChat } from "../../hooks/useHandleNewChat";
import type { ChatRightPanel } from "../../diffRouteSearch";
import { stripDiffSearchParams } from "../../diffRouteSearch";
import {
  canComposerHandlePanelWidth,
  createPanelResizeOverlay,
  attachPanelPointerOverlaySession,
  removePanelResizeOverlay,
} from "../../lib/panelResize";
import { splitViewPaneScopeId } from "../../lib/chatPaneScope";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { SubagentsDockPane } from "./SubagentsDockPane";
import { DockExplorerPane } from "./DockExplorerPane";
import { DockPaneHeader } from "./DockPaneHeader";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { LayoutRightIcon, PanelCollapseIcon, PanelExpandIcon } from "~/lib/icons";
import { useWorkspaceFocusModeStore } from "../../workspaceFocusModeStore";
import { resolveActiveSplitView } from "../../splitViewRoute";
import {
  canSubdividePane,
  collectLeaves,
  findDirectionalNeighbor,
  findLeafPaneById,
  type PaneFocusDirection,
} from "../../splitView.logic";
import { useSplitViewShortcuts } from "../../hooks/useSplitViewShortcuts";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  resolveSplitViewThreadIds,
  selectSplitView,
  type LeafPane,
  type LeafPaneContent,
  type PaneId,
  type SplitPanePanel,
  type SplitDirection,
  type SplitDropSide,
  type SplitView,
  type SplitViewId,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../../splitViewStore";
import { useStore } from "../../store";
import {
  createProjectSelector,
  createThreadShellsSelector,
  createThreadWorkspaceMetadataSelector,
} from "../../storeSelectors";
import {
  resolveFilePreviewWorkspaceRoot,
  resolveSplitPaneCloseDecision,
  resolveThreadPickerTitle,
  resolveToggledChatPanelPatch,
} from "../../routes/-chatThreadRoute.logic";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { ChatPaneBody, KeptChatPane } from "./ChatPaneKeepAlive";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "./composerPickerStyles";
import { getRightDockPaneMeta } from "./rightDockPaneMeta";
import { routeSplitBrowserPanelOpenRequest } from "./browserPanelOpenRequest";
import { cn } from "~/lib/utils";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import { useTranslation } from "~/i18n";

const SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 22 * 16;
const BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 30 * 16;
const SPLIT_PANE_CHAT_MIN_WIDTH = 20 * 16;
const SINGLE_PANEL_MIN_WIDTH = 26 * 16;
const BROWSER_PANEL_MIN_WIDTH = 21 * 16;
const RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_width";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const DockTerminalPane = lazy(() => import("./DockTerminalPane"));
// Split panes cannot reuse the desktop Sidebar primitive because it positions the panel
// against the viewport. This embedded shell keeps side-panel content anchored to the pane.
function SplitPaneEmbeddedPanel(props: {
  splitViewId: SplitViewId;
  paneId: PaneId;
  paneScopeId: string;
  panelOpen: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadId | null;
  projectId: ProjectId | null;
  onClosePanel: () => void;
  onOpenThread: (threadId: ThreadId) => void;
  panelState: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  isFocused: boolean;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
}) {
  const { t } = useTranslation();

  const dockState = useRightDockStore(selectRightDockState(props.threadId));
  const terminalPane = dockState.open
    ? dockState.panes.find((pane) => pane.id === dockState.activePaneId && pane.kind === "terminal")
    : undefined;
  const subagentsPane = dockState.open
    ? dockState.panes.find(
        (pane) => pane.id === dockState.activePaneId && pane.kind === "subagents",
      )
    : undefined;
  const panel = terminalPane || subagentsPane ? null : props.panel;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelWidthStorageKey =
    panel === "browser" ? "browser" : panel === "diff" ? "diff" : "panel";
  const storageKey = `${RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY}:${props.splitViewId}:${props.paneId}:${panelWidthStorageKey}`;
  const defaultPanelWidth =
    panel === "browser"
      ? BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX
      : SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX;
  const minPanelWidth = panel === "browser" ? BROWSER_PANEL_MIN_WIDTH : SINGLE_PANEL_MIN_WIDTH;
  // Keyed by storageKey so switching panel/pane re-reads the persisted width by
  // deriving during render instead of resetting from an effect. Resizes stamp the
  // current key; a stale key re-reads localStorage for the new panel's value.
  const [panelWidthState, setPanelWidthState] = useState<{ key: string; value: number }>(() => ({
    key: storageKey,
    value: getLocalStorageItem(storageKey, Schema.Finite) ?? defaultPanelWidth,
  }));
  const panelWidth =
    panelWidthState.key === storageKey
      ? panelWidthState.value
      : (getLocalStorageItem(storageKey, Schema.Finite) ?? defaultPanelWidth);

  const shouldAcceptEmbeddedWidth = (nextWidth: number) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return true;
    return canComposerHandlePanelWidth({
      nextWidth,
      paneScopeId: props.paneScopeId,
      applyWidth: (width) => {
        wrapper.style.width = `${width}px`;
      },
      resetWidth: () => {
        wrapper.style.width = `${panelWidth}px`;
      },
    });
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const wrapper = wrapperRef.current;
    const parent = wrapper?.parentElement;
    if (!wrapper || !parent) return;

    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = wrapper.getBoundingClientRect().width;
    const maxWidth = Math.max(minPanelWidth, parent.clientWidth - SPLIT_PANE_CHAT_MIN_WIDTH);
    const resizeOverlay = createPanelResizeOverlay();
    let detachPointerSession = () => {};

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextWidth = Math.max(minPanelWidth, Math.min(maxWidth, startWidth + delta));
      if (!shouldAcceptEmbeddedWidth(nextWidth)) {
        return;
      }
      setPanelWidthState({ key: storageKey, value: nextWidth });
      setLocalStorageItem(storageKey, nextWidth, Schema.Finite);
    };

    const finish = () => {
      detachPointerSession();
      removePanelResizeOverlay(resizeOverlay);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    detachPointerSession = attachPanelPointerOverlaySession(resizeOverlay, {
      onMove: onPointerMove,
      onRelease: finish,
      onAbort: finish,
    });
  };

  if ((!props.panelOpen && !terminalPane && !subagentsPane) || !props.threadId) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      data-native-browser-surface={panel === "browser" ? "true" : undefined}
      className="relative flex h-full min-h-0 min-w-0 flex-none border-l border-[var(--app-surface-divider)] bg-card text-foreground"
      style={
        {
          width: `${panelWidth}px`,
          maxWidth: `calc(100% - ${SPLIT_PANE_CHAT_MIN_WIDTH}px)`,
          minWidth: minPanelWidth,
        } as CSSProperties
      }
    >
      <div
        className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-[var(--app-surface-divider)]"
        onPointerDown={startResize}
      />
      {subagentsPane ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DockPaneHeader
            title={t("chat:subagents")}
            closeLabel={t("chat:hideSubagents")}
            onClose={props.onClosePanel}
          />
          <SubagentsDockPane hostThreadId={props.threadId} onOpenThread={props.onOpenThread} />
        </div>
      ) : terminalPane ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DockPaneHeader
            title={t("workspace:viewportPane_terminal")}
            closeLabel={t("workspace:hideTerminal")}
            onClose={props.onClosePanel}
          />
          <Suspense fallback={<PanelStateMessage>{t("chat:loadingTerminal")}</PanelStateMessage>}>
            <DockTerminalPane
              hostThreadId={props.threadId}
              paneId={terminalPane.id}
              projectId={props.projectId}
              paneScopeId={props.paneScopeId}
              onClosePanel={props.onClosePanel}
            />
          </Suspense>
        </div>
      ) : panel === "browser" ? (
        <Suspense fallback={<PanelStateMessage>{t("computer:loadingBrowser")}</PanelStateMessage>}>
          <LazyBrowserPanel
            mode="sidebar"
            threadId={props.threadId}
            onClosePanel={props.onClosePanel}
          />
        </Suspense>
      ) : (
        <LazyDiffPanel
          mode="sidebar"
          threadId={props.threadId}
          onClosePanel={props.onClosePanel}
          panelState={props.panelState}
          liveRefreshEnabled={props.isFocused}
          onUpdatePanelState={props.onUpdatePanelState}
        />
      )}
    </div>
  );
}

function SplitPaneEmptyState(props: {
  onFocus: () => void;
  threads: readonly {
    id: ThreadId;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: ProviderKind };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  excludedThreadIds: ReadonlySet<ThreadId>;
  onSelectThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col items-center px-6 pt-16",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
      onMouseDown={props.onFocus}
    >
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-ui-lg font-medium text-foreground/70">
          {t("chat:selectAChat")}
        </p>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {props.threads.map((thread) => {
            const isUsed = props.excludedThreadIds.has(thread.id);
            const projectName =
              props.projects.find((p) => p.id === thread.projectId)?.name ?? "Project";
            return (
              <button
                key={thread.id}
                type="button"
                disabled={isUsed}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                  isUsed
                    ? "cursor-default border-border/30 opacity-35"
                    : "border-[color:var(--color-border-light)] hover:bg-[var(--sidebar-accent)]",
                )}
                onClick={() => {
                  if (!isUsed) props.onSelectThread(thread.id);
                }}
              >
                <ProviderIcon
                  provider={thread.modelSelection.provider}
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-lg leading-snug font-medium text-foreground">
                    {resolveThreadPickerTitle(thread.title)}
                  </div>
                  <div className="truncate text-ui leading-snug text-muted-foreground">
                    {projectName}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SPLIT_PANE_PANEL_KINDS: readonly SplitPanePanel[] = [
  "terminal",
  "browser",
  "diff",
  "explorer",
];

function SplitPaneChrome(props: {
  activePanel: SplitPanePanel | null;
  maximized: boolean;
  onSelectPanel: (panel: SplitPanePanel | null) => void;
  onToggleMaximize: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Menu modal={false}>
        <MenuTrigger
          render={
            <IconButton
              variant="ghost"
              size="icon-xs"
              label={t("chat:pane_panelMenu")}
              tooltip={t("chat:pane_panelMenu")}
              tooltipSide="bottom"
            >
              <LayoutRightIcon className="size-4" />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
          <MenuItem onClick={() => props.onSelectPanel(null)}>
            <span className="flex-1">{t("chat:pane_chat")}</span>
          </MenuItem>
          {SPLIT_PANE_PANEL_KINDS.map((panel) => (
            <MenuItem key={panel} onClick={() => props.onSelectPanel(panel)}>
              <span className="flex-1">{getRightDockPaneMeta(panel).label}</span>
            </MenuItem>
          ))}
        </ComposerPickerMenuPopup>
      </Menu>
      <IconButton
        variant="ghost"
        size="icon-xs"
        label={props.maximized ? t("chat:restorePanel") : t("chat:maximizePanel")}
        tooltip={props.maximized ? t("chat:restorePanel") : t("chat:maximizePanel")}
        tooltipSide="bottom"
        aria-pressed={props.maximized}
        onClick={props.onToggleMaximize}
      >
        {props.maximized ? (
          <PanelCollapseIcon className="size-4" />
        ) : (
          <PanelExpandIcon className="size-4" />
        )}
      </IconButton>
    </div>
  );
}

function SplitPanePanelSurface(props: {
  paneId: PaneId;
  panelState: SplitViewPanePanelState;
  panel: SplitPanePanel;
  threadId: ThreadId;
  projectId: ProjectId | null;
  paneScopeId: string;
  isFocused: boolean;
  onFocus: () => void;
  onBackToChat: () => void;
  chrome?: ReactNode;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "diffTurnId" | "diffFilePath">>,
  ) => void;
}) {
  const { t } = useTranslation();
  const threadWorkspace = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.threadId), [props.threadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const workspaceRoot = resolveFilePreviewWorkspaceRoot({
    projectCwd: project?.cwd ?? null,
    threadEnvMode: threadWorkspace.envMode ?? null,
    threadWorktreePath: threadWorkspace.worktreePath ?? null,
    threadWorkingDirectory: threadWorkspace.workingDirectory ?? null,
  });
  const meta = getRightDockPaneMeta(props.panel);

  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", CHAT_BACKGROUND_CLASS_NAME)}
      onMouseDown={props.onFocus}
    >
      <DockPaneHeader
        title={meta.label}
        actions={props.chrome}
        closeLabel={t("chat:pane_backToChat")}
        onClose={props.onBackToChat}
      />
      <div className="relative min-h-0 flex-1">
        {props.panel === "terminal" ? (
          <Suspense fallback={<PanelStateMessage>{t("chat:loadingTerminal")}</PanelStateMessage>}>
            <DockTerminalPane
              hostThreadId={props.threadId}
              paneId={`split-panel:${props.paneId}`}
              projectId={props.projectId}
              paneScopeId={props.paneScopeId}
              isActive={props.isFocused}
              onClosePanel={props.onBackToChat}
            />
          </Suspense>
        ) : props.panel === "browser" ? (
          <Suspense
            fallback={<PanelStateMessage>{t("computer:loadingBrowser")}</PanelStateMessage>}
          >
            <LazyBrowserPanel
              mode="sidebar"
              threadId={props.threadId}
              onClosePanel={props.onBackToChat}
            />
          </Suspense>
        ) : props.panel === "explorer" ? (
          <DockExplorerPane
            threadId={props.threadId}
            workspaceRoot={workspaceRoot}
            isVisible={props.isFocused}
          />
        ) : (
          <LazyDiffPanel
            mode="sidebar"
            threadId={props.threadId}
            panelState={{
              panel: "diff",
              diffTurnId: props.panelState.diffTurnId,
              diffFilePath: props.panelState.diffFilePath,
            }}
            liveRefreshEnabled={props.isFocused}
            onUpdatePanelState={props.onUpdatePanelState}
            onClosePanel={props.onBackToChat}
          />
        )}
      </div>
    </div>
  );
}

function SplitPaneSurface(props: {
  splitView: SplitView;
  paneId: PaneId;
  threadId: ThreadId | null;
  content: LeafPaneContent | undefined;
  panelState: SplitViewPanePanelState;
  isFocused: boolean;
  deferChatMount: boolean;
  maximized: boolean;
  onToggleMaximize: () => void;
  onSetPanelContent: (panel: SplitPanePanel | null) => void;
  canDropInDirection: (direction: SplitDirection) => boolean;
  excludedThreadIds: ReadonlySet<ThreadId>;
  threads: readonly {
    id: ThreadId;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: ProviderKind };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  onFocus: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onClosePanel: () => void;
  showFloatingBrowser: boolean;
  onCloseFloatingBrowser: () => void;
  onPopFloatingBrowser: () => void;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onCloseThreadPane: () => void;
  onSelectThread: (threadId: ThreadId) => void;
  onChatMounted: () => void;
  onDropThread: (payload: {
    droppedThreadId: ThreadId;
    direction: SplitDirection;
    side: SplitDropSide;
  }) => void;
}) {
  const paneScopeId = splitViewPaneScopeId(props.splitView.id, props.paneId);
  const dockState = useRightDockStore(selectRightDockState(props.threadId));
  const terminalPane =
    dockState.panes.find(
      (pane) => pane.id === dockState.activePaneId && pane.kind === "terminal",
    ) ?? dockState.panes.find((pane) => pane.kind === "terminal");
  const panelOpen = props.panelState.panel !== null;
  const shouldRenderPanelContent = panelOpen || props.panelState.hasOpenedPanel;
  const projectId =
    props.threads.find((thread) => thread.id === props.threadId)?.projectId ??
    props.splitView.ownerProjectId;
  const panelContent = props.content?.kind === "panel" ? props.content.panel : null;
  const chrome = (
    <SplitPaneChrome
      activePanel={panelContent}
      maximized={props.maximized}
      onSelectPanel={props.onSetPanelContent}
      onToggleMaximize={props.onToggleMaximize}
    />
  );

  const onDropThread = props.onDropThread;
  const handleDrop = (payload: {
    threadId: ThreadId;
    direction: SplitDirection;
    side: SplitDropSide;
  }) => {
    onDropThread({
      droppedThreadId: payload.threadId,
      direction: payload.direction,
      side: payload.side,
    });
  };

  // A panel leaf shows a workspace panel as its whole content instead of the chat.
  if (panelContent && props.threadId) {
    return (
      <div
        className={cn(
          "group relative flex min-h-0 min-w-0 flex-1 [contain:layout_style_paint]",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
        data-split-pane-focused={props.isFocused ? "true" : undefined}
        data-split-pane-content={panelContent}
      >
        <SplitPanePanelSurface
          paneId={props.paneId}
          panelState={props.panelState}
          panel={panelContent}
          threadId={props.threadId}
          projectId={projectId}
          paneScopeId={paneScopeId}
          isFocused={props.isFocused}
          onFocus={props.onFocus}
          onBackToChat={() => props.onSetPanelContent(null)}
          chrome={chrome}
          onUpdatePanelState={props.onUpdatePanelState}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex min-h-0 min-w-0 flex-1 [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
      // The focused pane is marked only by its composer's accent border (see index.css);
      // unfocused panes stay undimmed so they never read as disabled.
      data-split-pane-focused={props.isFocused ? "true" : undefined}
    >
      {/* Kept alive across the swap with SingleChatSurface, and keyed by pane rather than by
          thread so replacing a pane's thread still reuses its chat. */}
      <KeptChatPane slotKey={paneScopeId} threadId={props.threadId}>
        <ChatPaneBody
          fileOpener={null}
          dropOverlay={{
            paneScopeId,
            canDropInDirection: props.canDropInDirection,
            excludedThreadIds: props.excludedThreadIds,
            onDrop: handleDrop,
            className: "flex min-h-0 min-w-0 flex-1",
          }}
          inset={{
            className: "min-h-0 min-w-0 overflow-hidden overscroll-y-none text-foreground",
            surfaceClassName: CHAT_BACKGROUND_CLASS_NAME,
            onMouseDown: props.onFocus,
          }}
        >
          {props.threadId ? (
            <DeferredChatView
              threadId={props.threadId}
              paneScopeId={paneScopeId}
              deferMount={props.deferChatMount}
              surfaceMode="split"
              isFocusedPane={props.isFocused}
              panelState={props.panelState}
              onToggleDiff={props.onToggleDiff}
              {...(terminalPane && props.threadId
                ? {
                    onToggleRightDock: () => {
                      const store = useRightDockStore.getState();
                      const hostId = props.threadId!;
                      const current = selectRightDockState(hostId)(store);
                      const terminalVisible =
                        current.open && current.activePaneId === terminalPane.id;
                      store.setActivePane(hostId, terminalPane.id);
                      store.setDockOpen(hostId, !terminalVisible);
                    },
                  }
                : {})}
              onToggleBrowser={props.onToggleBrowser}
              onOpenBrowserUrl={props.onOpenBrowserUrl}
              onOpenTurnDiff={props.onOpenTurnDiff}
              onCloseThreadPane={props.onCloseThreadPane}
              paneChrome={chrome}
              onMounted={props.onChatMounted}
            />
          ) : (
            <SplitPaneEmptyState
              onFocus={props.onFocus}
              threads={props.threads}
              projects={props.projects}
              excludedThreadIds={props.excludedThreadIds}
              onSelectThread={props.onSelectThread}
            />
          )}
          {props.threadId && props.showFloatingBrowser ? (
            <FloatingBrowserPanel
              key={props.threadId}
              threadId={props.threadId}
              onClose={props.onCloseFloatingBrowser}
              onPopToSidebar={props.onPopFloatingBrowser}
            />
          ) : null}
        </ChatPaneBody>
      </KeptChatPane>
      <SplitPaneEmbeddedPanel
        splitViewId={props.splitView.id}
        paneId={props.paneId}
        paneScopeId={paneScopeId}
        panelOpen={panelOpen && shouldRenderPanelContent}
        panel={props.panelState.panel}
        threadId={props.threadId}
        projectId={
          props.threads.find((thread) => thread.id === props.threadId)?.projectId ??
          props.splitView.ownerProjectId
        }
        onClosePanel={props.onClosePanel}
        onOpenThread={props.onSelectThread}
        panelState={props.panelState}
        isFocused={props.isFocused}
        onUpdatePanelState={props.onUpdatePanelState}
      />
    </div>
  );
}

// Module-level and shell-only: this surface only reads shell fields (title, projectId,
// modelSelection, timestamps, sidechatSourceThreadId), so subscribing to full threads would
// rebuild every thread's message/activity lists on each streaming flush for no benefit.
const selectThreadShells = createThreadShellsSelector();

export function SplitChatSurface(props: { splitViewId: SplitViewId; routeThreadId: ThreadId }) {
  const navigate = useNavigate();
  const { handleNewChat } = useHandleNewChat();
  const threads = useStore(selectThreadShells);
  const projects = useStore((store) => store.projects);
  const splitView = useSplitViewStore(
    useMemo(() => selectSplitView(props.splitViewId), [props.splitViewId]),
  );
  const setFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const setRatioForNode = useSplitViewStore((store) => store.setRatioForNode);
  const setPanePanelState = useSplitViewStore((store) => store.setPanePanelState);
  const replacePaneThread = useSplitViewStore((store) => store.replacePaneThread);
  const dropThreadOnPane = useSplitViewStore((store) => store.dropThreadOnPane);
  const splitPaneInSplitView = useSplitViewStore((store) => store.splitPaneInSplitView);
  const removeSplitView = useSplitViewStore((store) => store.removeSplitView);
  const removePaneFromSplitView = useSplitViewStore((store) => store.removePaneFromSplitView);
  const setPaneContent = useSplitViewStore((store) => store.setPaneContent);
  const movePaneContent = useSplitViewStore((store) => store.movePaneContent);
  const setMaximizedPane = useSplitViewStore((store) => store.setMaximizedPane);
  const focusModeEnabled = useWorkspaceFocusModeStore((store) => store.enabled);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const requestFloatingBrowser = useFloatingBrowserRequestStore((store) => store.request);
  const dismissFloatingBrowserForThread = useFloatingBrowserRequestStore((store) => store.dismiss);
  const floatingBrowserRequestedByThreadId = useFloatingBrowserRequestStore(
    (store) => store.requestedByThreadId,
  );
  const { splitView: activeSplitView, routePaneId } = resolveActiveSplitView({
    splitView,
    routeThreadId: props.routeThreadId,
  });

  useEffect(() => {
    if (!activeSplitView) {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.routeThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      });
      return;
    }

    // Single-leaf split views collapse back to the single chat surface.
    const leaves = collectLeaves(activeSplitView.root);
    if (leaves.length <= 1) {
      const onlyThreadId = leaves[0]?.threadId ?? null;
      const fallbackThreadId = onlyThreadId ?? props.routeThreadId;
      if (!fallbackThreadId) {
        removeSplitView(activeSplitView.id);
        void handleNewChat();
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: fallbackThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      }).then(() => removeSplitView(activeSplitView.id));
      return;
    }

    // If the route threadId targets a non-focused pane, switch focus to that pane.
    const focusedLeaf = findLeafPaneById(activeSplitView.root, activeSplitView.focusedPaneId);
    if (
      routePaneId &&
      routePaneId !== activeSplitView.focusedPaneId &&
      focusedLeaf?.threadId !== null &&
      focusedLeaf?.threadId !== undefined
    ) {
      setFocusedPane(activeSplitView.id, routePaneId);
      return;
    }

    // Sync the route threadId with the focused leaf's thread.
    const normalizedFocusedThreadId = resolveSplitViewFocusedThreadId(activeSplitView);
    if (normalizedFocusedThreadId && props.routeThreadId !== normalizedFocusedThreadId) {
      void navigate({
        to: "/$threadId",
        params: { threadId: normalizedFocusedThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: activeSplitView.id,
        }),
      });
    }
  }, [
    activeSplitView,
    handleNewChat,
    navigate,
    props.routeThreadId,
    removeSplitView,
    routePaneId,
    setFocusedPane,
  ]);

  const setPaneFocus = (paneId: PaneId) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    const nextThreadId = leaf?.threadId ?? resolveSplitViewFocusedThreadId(activeSplitView);
    setFocusedPane(activeSplitView.id, paneId);
    if (!nextThreadId || nextThreadId === props.routeThreadId) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        splitViewId: activeSplitView.id,
      }),
    });
  };

  const updatePanePanelState = (
    paneId: PaneId,
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    if (!leaf) return;
    if (patch.panel !== undefined && leaf.threadId) {
      useRightDockStore.getState().setDockOpen(leaf.threadId, false);
    }
    const nextPanel = patch.panel ?? leaf.panel.panel;
    setPanePanelState(activeSplitView.id, paneId, {
      ...patch,
      hasOpenedPanel: leaf.panel.hasOpenedPanel || nextPanel !== null,
      lastOpenPanel:
        patch.panel === "browser" || patch.panel === "diff"
          ? patch.panel
          : leaf.panel.lastOpenPanel,
    });
  };

  const togglePanePanel = (paneId: PaneId, panel: ChatRightPanel) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    if (!leaf?.threadId) {
      return;
    }
    const dock = selectRightDockState(leaf.threadId)(useRightDockStore.getState());
    const terminalOpen =
      dock.open &&
      dock.panes.some(
        (pane) =>
          pane.id === dock.activePaneId && (pane.kind === "terminal" || pane.kind === "subagents"),
      );
    updatePanePanelState(
      paneId,
      resolveToggledChatPanelPatch(
        terminalOpen ? { ...leaf.panel, panel: null } : leaf.panel,
        panel,
      ),
    );
  };

  useBrowserPanelDesktopBridge({
    onToggle: activeSplitView
      ? () => togglePanePanel(activeSplitView.focusedPaneId, "browser")
      : null,
    onOpen: activeSplitView
      ? (requestedThreadId) => {
          routeSplitBrowserPanelOpenRequest({
            splitView: activeSplitView,
            requestedThreadId,
            showFloatingBrowser: (paneId) => {
              const leaf = findLeafPaneById(activeSplitView.root, paneId);
              if (!leaf?.threadId) {
                return;
              }
              requestFloatingBrowser(leaf.threadId);
            },
            rememberFloatingBrowser: requestFloatingBrowser,
          });
        }
      : null,
  });

  const closeFloatingBrowser = (threadId: ThreadId) => {
    dismissFloatingBrowserForThread(threadId);
  };

  const popFloatingBrowser = (paneId: PaneId) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    if (!leaf?.threadId) return;
    dismissFloatingBrowserForThread(leaf.threadId);
    updatePanePanelState(paneId, { panel: "browser" });
  };

  const closePanePanel = (paneId: PaneId) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    if (leaf?.threadId) {
      const store = useRightDockStore.getState();
      const dock = selectRightDockState(leaf.threadId)(store);
      if (
        dock.open &&
        dock.panes.some(
          (pane) =>
            pane.id === dock.activePaneId &&
            (pane.kind === "terminal" || pane.kind === "subagents"),
        )
      ) {
        store.setDockOpen(leaf.threadId, false);
        return;
      }
    }
    updatePanePanelState(paneId, { panel: null });
  };

  const openPaneTurnDiff = (paneId: PaneId, turnId: TurnId, filePath?: string) => {
    updatePanePanelState(paneId, {
      panel: "diff",
      diffTurnId: turnId,
      diffFilePath: filePath ?? null,
    });
  };

  const closePaneThread = (paneId: PaneId) => {
    if (!activeSplitView) return;
    const closingLeaf = findLeafPaneById(activeSplitView.root, paneId);
    const closingThread = closingLeaf?.threadId
      ? threads.find((thread) => thread.id === closingLeaf.threadId)
      : null;

    // Returning to a source discards the entire split. Keep its tree intact until
    // navigation commits, so publishing leftover leaves cannot race the exit.
    if (
      closingThread?.sidechatSourceThreadId ||
      (closingThread &&
        isSidechatThread(closingThread) &&
        closingThread.id !== activeSplitView.sourceThreadId)
    ) {
      const decision = resolveSplitPaneCloseDecision({
        splitViewId: activeSplitView.id,
        sourceThreadId: activeSplitView.sourceThreadId,
        closingThreadId: closingLeaf?.threadId ?? null,
        closingSidechatSourceThreadId: closingThread?.sidechatSourceThreadId ?? null,
        closingSidechatContext: closingThread?.sidechatContext ?? null,
        nextFocusedThreadId: null,
        nextLeafCount: 0,
      });
      if (decision.kind !== "single-thread") return;
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      }).then(() => {
        removeSplitView(decision.splitViewIdToRemove);
      });
      return;
    }

    // Closing one of two panes collapses to the survivor and discards the split. Keep the
    // tree until navigation commits, because the store drops a split at once when its
    // survivor already anchors another split, which would leave no chat to land on.
    const remainingLeaves = collectLeaves(activeSplitView.root).filter(
      (leaf) => leaf.id !== paneId,
    );
    const survivingThreadId = remainingLeaves.length === 1 ? remainingLeaves[0]!.threadId : null;
    if (survivingThreadId) {
      void navigate({
        to: "/$threadId",
        params: { threadId: survivingThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      }).then(() => removeSplitView(activeSplitView.id));
      return;
    }

    const closed = removePaneFromSplitView({
      splitViewId: activeSplitView.id,
      paneId,
    });
    if (!closed) return;

    const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
    const nextThreadId = nextSplitView ? resolveSplitViewFocusedThreadId(nextSplitView) : null;
    const decision = resolveSplitPaneCloseDecision({
      splitViewId: activeSplitView.id,
      sourceThreadId: activeSplitView.sourceThreadId,
      closingThreadId: closingLeaf?.threadId ?? null,
      closingSidechatSourceThreadId: null,
      nextFocusedThreadId: nextThreadId,
      nextLeafCount: nextSplitView ? collectLeaves(nextSplitView.root).length : 0,
    });

    if (decision.kind === "single-thread") {
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      }).then(() => removeSplitView(decision.splitViewIdToRemove));
      return;
    }

    if (decision.kind === "split-thread") {
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: decision.splitViewId,
        }),
      });
      return;
    }

    void handleNewChat();
  };

  const handleSetRatio = (nodeId: PaneId, ratio: number) => {
    if (!activeSplitView) return;
    setRatioForNode(activeSplitView.id, nodeId, ratio);
  };

  const handleDropThreadOnPane = (
    paneId: PaneId,
    payload: {
      droppedThreadId: ThreadId;
      direction: SplitDirection;
      side: SplitDropSide;
    },
  ) => {
    if (!activeSplitView) return;
    const ok = dropThreadOnPane({
      splitViewId: activeSplitView.id,
      targetPaneId: paneId,
      direction: payload.direction,
      side: payload.side,
      threadId: payload.droppedThreadId,
    });
    if (!ok) return;
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: payload.droppedThreadId },
        replace: true,
        search: () => ({ splitViewId: activeSplitView.id }),
      });
    });
  };

  // Splits the focused pane whenever a split view is open. The new leaf starts empty and takes
  // focus, so the user can pick a thread (or drop one) right where the pane appeared.
  const handleSplitFocusedPane = (direction: SplitDirection, side: SplitDropSide) => {
    if (!activeSplitView) return;
    splitPaneInSplitView({
      splitViewId: activeSplitView.id,
      paneId: activeSplitView.focusedPaneId,
      direction,
      side,
    });
  };

  const handleFocusAdjacentPane = (direction: PaneFocusDirection) => {
    if (!activeSplitView) return;
    const neighbor = findDirectionalNeighbor(
      activeSplitView.root,
      activeSplitView.focusedPaneId,
      direction,
    );
    if (neighbor) setPaneFocus(neighbor.id);
  };

  const handleCloseFocusedPane = () => {
    if (!activeSplitView) return;
    closePaneThread(activeSplitView.focusedPaneId);
  };

  const handleMoveFocusedPane = (direction: PaneFocusDirection) => {
    if (!activeSplitView) return;
    const neighbor = findDirectionalNeighbor(
      activeSplitView.root,
      activeSplitView.focusedPaneId,
      direction,
    );
    if (!neighbor) return;
    movePaneContent({
      splitViewId: activeSplitView.id,
      fromPaneId: activeSplitView.focusedPaneId,
      toPaneId: neighbor.id,
    });
  };

  const handleToggleMaximizedPane = () => {
    if (!activeSplitView) return;
    // Focus mode already shows one pane; the restore affordance exits that mode
    // rather than flipping a stored maximize the user cannot see.
    if (focusModeEnabled) {
      useWorkspaceFocusModeStore.getState().setEnabled(false);
      return;
    }
    setMaximizedPane(
      activeSplitView.id,
      activeSplitView.maximizedPaneId === activeSplitView.focusedPaneId
        ? null
        : activeSplitView.focusedPaneId,
    );
  };

  useSplitViewShortcuts({
    enabled: activeSplitView !== null,
    keybindings,
    onSplit: handleSplitFocusedPane,
    onFocusDirection: handleFocusAdjacentPane,
    onClosePane: handleCloseFocusedPane,
    onMoveDirection: handleMoveFocusedPane,
    onToggleMaximize: handleToggleMaximizedPane,
  });

  const selectableThreads = useMemo(
    () =>
      threads
        .filter((thread) => !isSidechatThread(thread))
        .toSorted(
          (left, right) =>
            Date.parse(right.updatedAt ?? right.createdAt) -
            Date.parse(left.updatedAt ?? left.createdAt),
        ),
    [threads],
  );
  const splitThreadIds = new Set(activeSplitView ? resolveSplitViewThreadIds(activeSplitView) : []);

  if (!activeSplitView) {
    return <ChatMountLoader />;
  }

  const chooseThreadForPane = (threadId: ThreadId, paneId: PaneId) => {
    const existingPaneIdForThread = resolveSplitViewPaneIdForThread(activeSplitView, threadId);
    if (existingPaneIdForThread && existingPaneIdForThread !== paneId) {
      setPaneFocus(existingPaneIdForThread);
      return;
    }

    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    setFocusedPane(activeSplitView.id, paneId);
    if (leaf && leaf.threadId !== threadId) {
      replacePaneThread(activeSplitView.id, paneId, threadId);
      setPanePanelState(activeSplitView.id, paneId, {
        diffTurnId: null,
        diffFilePath: null,
      });
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        splitViewId: activeSplitView.id,
      }),
    });
  };

  const effectiveMaximizedPaneId = focusModeEnabled
    ? activeSplitView.focusedPaneId
    : activeSplitView.maximizedPaneId;
  const renderLeaf = ({ leaf }: { leaf: LeafPane }): ReactNode => {
    const isFocused = leaf.id === activeSplitView.focusedPaneId;
    const excluded = new Set<ThreadId>(splitThreadIds);
    return (
      <SplitPaneSurface
        key={leaf.id}
        splitView={activeSplitView}
        paneId={leaf.id}
        threadId={leaf.threadId}
        content={leaf.content}
        panelState={leaf.panel}
        isFocused={isFocused}
        deferChatMount={false}
        maximized={effectiveMaximizedPaneId === leaf.id}
        onToggleMaximize={() => {
          if (focusModeEnabled) {
            useWorkspaceFocusModeStore.getState().setEnabled(false);
            return;
          }
          setMaximizedPane(
            activeSplitView.id,
            activeSplitView.maximizedPaneId === leaf.id ? null : leaf.id,
          );
        }}
        onSetPanelContent={(panel) => {
          // A panel leaf's thread is its chat neighbour's thread. Going back to chat
          // there would show that thread twice, so "Chat" closes the pane and the
          // split collapses back to the conversation.
          if (!panel && leaf.content) {
            closePaneThread(leaf.id);
            return;
          }
          setPaneContent(activeSplitView.id, leaf.id, panel ? { kind: "panel", panel } : null);
        }}
        canDropInDirection={(direction) =>
          canSubdividePane(activeSplitView.root, leaf.id, direction)
        }
        excludedThreadIds={excluded}
        threads={selectableThreads}
        projects={projects}
        onFocus={() => setPaneFocus(leaf.id)}
        onToggleDiff={() => togglePanePanel(leaf.id, "diff")}
        onToggleBrowser={() => togglePanePanel(leaf.id, "browser")}
        onOpenBrowserUrl={() => updatePanePanelState(leaf.id, { panel: "browser" })}
        onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff(leaf.id, turnId, filePath)}
        onClosePanel={() => closePanePanel(leaf.id)}
        showFloatingBrowser={shouldRenderFloatingBrowserPanel({
          hostThreadId: leaf.threadId,
          floatingThreadId:
            floatingBrowserRequestedByThreadId[leaf.threadId ?? ""] === true ? leaf.threadId : null,
          dockBrowserVisible: leaf.panel.panel === "browser",
          isFocused,
        })}
        onCloseFloatingBrowser={() => {
          if (leaf.threadId) closeFloatingBrowser(leaf.threadId);
        }}
        onPopFloatingBrowser={() => popFloatingBrowser(leaf.id)}
        onUpdatePanelState={(patch) => updatePanePanelState(leaf.id, patch)}
        onCloseThreadPane={() => closePaneThread(leaf.id)}
        onSelectThread={(threadId) => chooseThreadForPane(threadId, leaf.id)}
        onChatMounted={noopChatSurfaceAction}
        onDropThread={(payload) => handleDropThreadOnPane(leaf.id, payload)}
      />
    );
  };

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <SplitPaneLayout
        pane={activeSplitView.root}
        renderLeaf={renderLeaf}
        onSetRatio={handleSetRatio}
        maximizedPaneId={effectiveMaximizedPaneId ?? null}
      />
    </div>
  );
}
