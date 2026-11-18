// Page-side executor for agent-driven browser automation.
//
// The bridge forwards a daemon `browser.automation.execute` request to one Electron window.
// That window runs this module: commands that need a live page go to the Electron main
// process, which owns the CDP session for the registered `<webview>`; commands that change
// the browser UI (`new_tab`, `close_tab`) are applied to the renderer state so the panel
// mounts the new webview. `resize` has no meaning for a webview that fills its panel.
import type { BrowserAutomationHostRequest } from "@synara/contracts";

export interface BrowserAutomationResponseFailure {
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface BrowserAutomationResponseSuccess {
  readonly requestId: string;
  readonly ok: true;
  readonly result: unknown;
}

export type BrowserAutomationResponse =
  | BrowserAutomationResponseSuccess
  | BrowserAutomationResponseFailure;

/** The subset of the desktop bridge this executor calls. */
export interface BrowserAutomationBridge {
  executeAutomationCommand?(request: Record<string, unknown>): Promise<unknown>;
  open(input: { threadId: string; initialUrl?: string }): Promise<unknown>;
  newTab(input: { threadId: string; url?: string; activate?: boolean }): Promise<unknown>;
  closeTab(input: { threadId: string; tabId: string }): Promise<unknown>;
}

export interface BrowserAutomationExecutorDeps {
  readonly bridge: BrowserAutomationBridge | null;
  /** The thread this window should use for a workspace, or the focused thread fallback. */
  readonly resolveThreadId: (request: BrowserAutomationHostRequest) => string | null;
  /** Thread that owns a tab, from this window's browser state. */
  readonly findTabThreadId: (browserId: string) => string | null;
  /** The daemon workspace a thread belongs to, used to scope tab lists and targets. */
  readonly workspaceIdForThread: (threadId: string) => string | null;
  /** Reveals the browser panel for a thread so the tab's webview attaches. */
  readonly openPanel: (threadId: string) => void;
  /** Polls Electron until the tab's webview has registered; false on timeout. */
  readonly waitForTabRegistration: (browserId: string) => Promise<boolean>;
  readonly defaultNewTabUrl?: string;
}

const DEFAULT_NEW_TAB_URL = "https://example.com";

export async function executeBrowserAutomationRequest(
  deps: BrowserAutomationExecutorDeps,
  request: BrowserAutomationHostRequest,
): Promise<BrowserAutomationResponse> {
  const bridge = deps.bridge;
  if (!bridge?.executeAutomationCommand) {
    return failure(
      request.requestId,
      "browser_unsupported",
      "Browser automation is not available in this app runtime.",
    );
  }

  try {
    switch (readCommandName(request.command)) {
      case "new_tab":
        return await openTab(deps, bridge, request);
      case "close_tab":
        return await closeTab(deps, bridge, request);
      case "resize":
        return failure(
          request.requestId,
          "browser_unsupported",
          "The desktop web browser fills its panel, so agent-driven resizing is unavailable.",
        );
      case "list_tabs":
        return await listTabs(deps, bridge, request);
      default:
        return await forwardCommand(deps, bridge, request);
    }
  } catch (error) {
    return normalizeThrownError(request.requestId, error);
  }
}

async function openTab(
  deps: BrowserAutomationExecutorDeps,
  bridge: BrowserAutomationBridge,
  request: BrowserAutomationHostRequest,
): Promise<BrowserAutomationResponse> {
  const workspaceId = request.workspaceId;
  if (!workspaceId) {
    return failure(
      request.requestId,
      "browser_unsupported",
      "Cannot create a browser tab without a workspace context.",
    );
  }
  const threadId = deps.resolveThreadId(request);
  if (!threadId) {
    return failure(
      request.requestId,
      "browser_unsupported",
      "Cannot create a browser tab without a workspace context.",
    );
  }

  const url = readNewTabUrl(request.command) ?? deps.defaultNewTabUrl ?? DEFAULT_NEW_TAB_URL;
  await bridge.open({ threadId, initialUrl: url }).catch(() => undefined);
  const state = await bridge.newTab({ threadId, url, activate: true });
  const browserId = readNewTabId(state);
  if (!browserId) {
    return failure(
      request.requestId,
      "browser_unknown_error",
      "The browser tab was created without an id.",
    );
  }

  deps.openPanel(threadId);
  if (!(await deps.waitForTabRegistration(browserId))) {
    return failure(
      request.requestId,
      "browser_timeout",
      `Timed out waiting for browser tab ${browserId} to attach. Try browser_new_tab again.`,
      true,
    );
  }

  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "new_tab", browserId, workspaceId, url },
  };
}

async function closeTab(
  deps: BrowserAutomationExecutorDeps,
  bridge: BrowserAutomationBridge,
  request: BrowserAutomationHostRequest,
): Promise<BrowserAutomationResponse> {
  const browserId = readBrowserId(request.command);
  if (!browserId) {
    return failure(request.requestId, "browser_unknown_error", "Missing browser tab id.");
  }
  const threadId = deps.findTabThreadId(browserId);
  if (!threadId) {
    return failure(
      request.requestId,
      "browser_tab_not_found",
      `No browser tab found for ID: ${browserId}`,
    );
  }
  await bridge.closeTab({ threadId, tabId: browserId });
  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "close_tab", browserId },
  };
}

async function listTabs(
  deps: BrowserAutomationExecutorDeps,
  bridge: BrowserAutomationBridge,
  request: BrowserAutomationHostRequest,
): Promise<BrowserAutomationResponse> {
  const payload = await forwardToBridge(bridge, request);
  if (!payload.ok || !isListTabsResult(payload.result)) {
    return payload;
  }
  const workspaceId = request.workspaceId;
  if (!workspaceId) return payload;
  const tabs = payload.result.tabs.filter((tab) => {
    if (tab.workspaceId) {
      return deps.workspaceIdForThread(tab.workspaceId) === workspaceId;
    }
    const threadId = deps.findTabThreadId(tab.browserId);
    return threadId !== null && deps.workspaceIdForThread(threadId) === workspaceId;
  });
  return { ...payload, result: { ...payload.result, tabs } };
}

async function forwardCommand(
  deps: BrowserAutomationExecutorDeps,
  bridge: BrowserAutomationBridge,
  request: BrowserAutomationHostRequest,
): Promise<BrowserAutomationResponse> {
  const browserId = readBrowserId(request.command);
  if (browserId && request.workspaceId) {
    const threadId = deps.findTabThreadId(browserId);
    const ownerWorkspace = threadId ? deps.workspaceIdForThread(threadId) : null;
    if (ownerWorkspace !== null && ownerWorkspace !== request.workspaceId) {
      return failure(
        request.requestId,
        "browser_tab_not_found",
        `No browser tab found for ID: ${browserId}`,
      );
    }
  }
  return forwardToBridge(bridge, request);
}

async function forwardToBridge(
  bridge: BrowserAutomationBridge,
  request: BrowserAutomationHostRequest,
): Promise<BrowserAutomationResponse> {
  const execute = bridge.executeAutomationCommand;
  if (!execute) {
    return failure(
      request.requestId,
      "browser_unsupported",
      "Browser automation is not available in this app runtime.",
    );
  }
  // `workspaceId` is deliberately omitted: the Electron registry keys tabs by the renderer
  // thread id, so passing the daemon workspace would look like a foreign workspace and every
  // command would answer `browser_tab_not_found`.
  const payload = await execute({
    type: "browser.automation.execute.request",
    requestId: request.requestId,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
    command: request.command,
  });
  return normalizePayload(request.requestId, payload);
}

interface BrowserTabListEntry {
  readonly browserId: string;
  readonly workspaceId?: string;
  readonly [key: string]: unknown;
}

function isListTabsResult(
  result: unknown,
): result is { readonly command: "list_tabs"; readonly tabs: BrowserTabListEntry[] } {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const record = result as { command?: unknown; tabs?: unknown };
  return (
    record.command === "list_tabs" &&
    Array.isArray(record.tabs) &&
    record.tabs.every(
      (tab) =>
        typeof tab === "object" &&
        tab !== null &&
        typeof (tab as { browserId?: unknown }).browserId === "string",
    )
  );
}

function normalizePayload(requestId: string, value: unknown): BrowserAutomationResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure(requestId, "browser_unknown_error", "Browser automation returned no result.");
  }
  const record = value as {
    ok?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown; retryable?: unknown };
  };
  if (record.ok === true) {
    return { requestId, ok: true, result: record.result };
  }
  return normalizeError(requestId, record.error);
}

function normalizeThrownError(requestId: string, error: unknown): BrowserAutomationResponse {
  const typed = readTypedError(error);
  if (typed) return { requestId, ok: false, error: typed };
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered")) {
    return failure(
      requestId,
      "browser_unsupported",
      "Browser automation is not implemented by this app build yet.",
    );
  }
  return failure(requestId, "browser_unknown_error", message);
}

function normalizeError(
  requestId: string,
  error: { code?: unknown; message?: unknown; retryable?: unknown } | undefined,
): BrowserAutomationResponse {
  const typed = readTypedError(error);
  return typed
    ? { requestId, ok: false, error: typed }
    : failure(requestId, "browser_unknown_error", "Browser automation failed.");
}

function readTypedError(
  value: unknown,
): { code: string; message: string; retryable: boolean } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { code?: unknown; message?: unknown; retryable?: unknown };
  if (typeof record.code !== "string" || !record.code.startsWith("browser_")) return null;
  if (typeof record.message !== "string" || record.message.length === 0) return null;
  return {
    code: record.code,
    message: record.message,
    retryable: record.retryable === true,
  };
}

function readCommandName(command: unknown): string | null {
  if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
  const name = (command as { command?: unknown }).command;
  return typeof name === "string" ? name : null;
}

function readBrowserId(command: unknown): string | null {
  if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
  const args = (command as { args?: unknown }).args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const browserId = (args as { browserId?: unknown }).browserId;
  return typeof browserId === "string" && browserId.length > 0 ? browserId : null;
}

function readNewTabUrl(command: unknown): string | null {
  if (typeof command !== "object" || command === null || Array.isArray(command)) return null;
  const args = (command as { args?: unknown }).args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const url = (args as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function readNewTabId(state: unknown): string | null {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const record = state as { activeTabId?: unknown; tabs?: unknown };
  if (typeof record.activeTabId === "string" && record.activeTabId.length > 0) {
    return record.activeTabId;
  }
  if (!Array.isArray(record.tabs) || record.tabs.length === 0) return null;
  const last = record.tabs[record.tabs.length - 1];
  if (typeof last !== "object" || last === null) return null;
  const id = (last as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function failure(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
): BrowserAutomationResponseFailure {
  return { requestId, ok: false, error: { code, message, retryable } };
}
