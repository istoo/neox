// Mounts one page (an Electron window) as a browser automation executor.
//
// The renderer is the only place that can drive the browser: the Electron main process
// owns the CDP session, but the `<webview>` and its tab state live here. The bridge keeps
// the daemon host registered only while at least one window holds this subscription.
import { ThreadId, type BrowserAutomationHostRequest } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useBrowserStateStore } from "~/browserStateStore";
import { useFocusedChatContext } from "~/focusedChatContext";
import { getConnectionClients } from "~/lib/hosts/connectionClients";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { getThreadFromState } from "~/threadDerivation";
import { useStore } from "~/store";
import { useSplitViewStore, type LeafPane, type Pane, type SplitView } from "~/splitViewStore";
import {
  executeBrowserAutomationRequest,
  type BrowserAutomationBridge,
  type BrowserAutomationExecutorDeps,
} from "~/lib/browserAutomationExecution";

const TAB_REGISTRATION_TIMEOUT_MS = 5_000;
const TAB_REGISTRATION_POLL_MS = 100;

export function BrowserAutomationCoordinator({ disabled = false }: { disabled?: boolean }): null {
  const navigate = useNavigate();
  const { focusedThreadId, splitView } = useFocusedChatContext();
  const contextRef = useRef({ focusedThreadId, splitView });
  useEffect(() => {
    contextRef.current = { focusedThreadId, splitView };
  }, [focusedThreadId, splitView]);

  useEffect(() => {
    // The tray quick panel is a transient picker with no chat surface to host a tab.
    if (disabled) return;
    const bridge = window.desktopBridge?.browser;
    // A remote host frame cannot open the local in-app browser, so it must not claim to.
    if (!bridge?.executeAutomationCommand || readExecutionContext()?.remote) return;

    const transport = getConnectionClients().execution;
    const executorBridge = bridge as BrowserAutomationBridge;
    const deps: BrowserAutomationExecutorDeps = {
      bridge: executorBridge,
      resolveThreadId: (request) =>
        resolveThreadForRequest(request, contextRef.current.focusedThreadId),
      findTabThreadId,
      workspaceIdForThread,
      openPanel: (threadId) => revealBrowserPanel(threadId, contextRef.current.splitView, navigate),
      waitForTabRegistration: (browserId) => waitForTabRegistration(executorBridge, browserId),
    };

    return transport.subscribeBrowserAutomation((request) => {
      void executeBrowserAutomationRequest(deps, request)
        .then((payload) => transport.respondBrowserAutomation(payload))
        .catch(() => undefined);
    });
  }, [disabled, navigate]);

  return null;
}

function resolveThreadForRequest(
  request: BrowserAutomationHostRequest,
  focusedThreadId: ThreadId | null,
): string | null {
  if (!request.workspaceId) return focusedThreadId;
  const state = useStore.getState();
  // The bridge projects a thread id as its agent id, so the calling agent names the thread
  // whose panel should own the tab. Prefer it when it still belongs to the same workspace.
  const agentThread = request.agentId
    ? getThreadFromState(state, ThreadId.makeUnsafe(request.agentId))
    : undefined;
  if (agentThread && agentThread.neolixWorkspaceId === request.workspaceId) {
    return agentThread.id;
  }
  const threads = (state.threadIds ?? [])
    .map((threadId) => getThreadFromState(state, threadId))
    .filter((thread) => thread?.neolixWorkspaceId === request.workspaceId);
  const preferred = threads.find((thread) => thread?.id === focusedThreadId) ?? threads[0];
  return preferred?.id ?? null;
}

function findTabThreadId(browserId: string): string | null {
  const states = useBrowserStateStore.getState().threadStatesByThreadId;
  for (const [threadId, state] of Object.entries(states)) {
    if (state?.tabs.some((tab) => tab.id === browserId)) return threadId;
  }
  return null;
}

function workspaceIdForThread(threadId: string): string | null {
  const thread = getThreadFromState(useStore.getState(), ThreadId.makeUnsafe(threadId));
  return thread?.neolixWorkspaceId ?? null;
}

function revealBrowserPanel(
  threadId: string,
  splitView: SplitView | null,
  navigate: ReturnType<typeof useNavigate>,
): void {
  if (splitView) {
    const pane = [...walkLeaves(splitView.root)].find((leaf) => leaf.threadId === threadId);
    if (pane) {
      useSplitViewStore.getState().setPanePanelState(splitView.id, pane.id, {
        panel: "browser",
        hasOpenedPanel: true,
        lastOpenPanel: "browser",
      });
      return;
    }
  }
  void navigate({
    to: "/$threadId",
    params: { threadId },
    search: (previous) => ({ ...previous, panel: "browser" }),
  });
}

function* walkLeaves(root: Pane): Generator<LeafPane> {
  if (root.kind === "leaf") {
    yield root;
    return;
  }
  yield* walkLeaves(root.first);
  yield* walkLeaves(root.second);
}

async function waitForTabRegistration(
  bridge: BrowserAutomationBridge,
  browserId: string,
): Promise<boolean> {
  const execute = bridge.executeAutomationCommand;
  if (!execute) return false;
  const deadline = Date.now() + TAB_REGISTRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await execute({
      type: "browser.automation.execute.request",
      requestId: `browser-register-${browserId}-${Date.now()}`,
      command: { command: "list_tabs", args: {} },
    }).catch(() => null);
    if (tabListContains(payload, browserId)) return true;
    await new Promise((resolve) => setTimeout(resolve, TAB_REGISTRATION_POLL_MS));
  }
  return false;
}

function tabListContains(payload: unknown, browserId: string): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as { ok?: unknown; result?: unknown };
  if (record.ok !== true) return false;
  const result = record.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const tabs = (result as { tabs?: unknown }).tabs;
  return (
    Array.isArray(tabs) &&
    tabs.some(
      (tab) =>
        typeof tab === "object" &&
        tab !== null &&
        (tab as { browserId?: unknown }).browserId === browserId,
    )
  );
}
