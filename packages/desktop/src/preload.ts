import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.neolixDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with NEOLIX_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const NEOLIX_BROWSER_PROFILE_PARTITION = "persist:neolix-browser";

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--neolix-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

type InvokeResult<T> = Promise<T>;

interface DesktopWindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
}

interface DesktopUpdateState {
  enabled: boolean;
  status:
    | "disabled"
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "downloaded"
    | "error";
  currentVersion: string;
  hostArch: "arm64" | "x64" | "other";
  appArch: "arm64" | "x64" | "other";
  runningUnderARM64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  installFailureCount: number;
  flavor: "production" | "beta" | "canary" | "cua" | "remote";
  releaseUrl: string | null;
  manualInstall: boolean;
}

interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

interface DesktopQuitConfirmationChat {
  id: string;
  title: string;
}

type DesktopQuitConfirmationResponse =
  | {
      requestId: string;
      phase: "ready";
      runningCount: number;
      chats: readonly DesktopQuitConfirmationChat[];
    }
  | { requestId: string; phase: "decision"; allow: boolean };

interface DesktopUiModeState {
  mode: "native" | "web";
  selectable: boolean;
}

interface DesktopKeepAwakeState {
  enabled: boolean;
  active: boolean;
  onBattery: boolean;
}

type DesktopOsPermissionKind =
  | "notifications"
  | "microphone"
  | "accessibility"
  | "screenRecording"
  | "fullDiskAccess";

type DesktopOsPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "not-determined"
  | "restricted"
  | "unavailable"
  | "unknown";

interface DesktopOsPermissionSnapshot {
  platform: "darwin" | "win32" | "linux" | "other";
  checkedAt: number;
  permissions: Record<DesktopOsPermissionKind, DesktopOsPermissionState>;
}

type DesktopSafariAccessInfo =
  | { supported: false }
  | {
      supported: true;
      appName: string;
      appPath: string | null;
      fullDiskAccess?: "granted" | "denied" | "unknown";
    };

interface BrowserTab {
  id: string;
  url: string;
  title: string;
  status: "live" | "suspended";
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastCommittedUrl: string | null;
  lastError: string | null;
  runtimeSurface: "renderer";
  openerTabId?: string;
}

interface ThreadBrowserState {
  threadId: string;
  version: number;
  open: boolean;
  activeTabId: string | null;
  tabs: BrowserTab[];
  lastError: string | null;
}

interface BrowserGuestEvent {
  webContentsId: number;
  type: "loading" | "navigate" | "title" | "favicon" | "error" | "destroyed";
  isLoading?: boolean;
  url?: string;
  title?: string;
  faviconUrl?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  message?: string;
}

const BLANK_BROWSER_URL = "about:blank";

function invokeCommand<T>(command: string, ...args: unknown[]): InvokeResult<T> {
  return ipcRenderer.invoke(command, ...args) as InvokeResult<T>;
}

function readBridgeOrigin(): string | null {
  const argument = process.argv.find((value) => value.startsWith("--neolix-bridge-url="));
  if (argument) {
    return argument.slice("--neolix-bridge-url=".length) || null;
  }
  if (typeof window === "undefined" || !window.location) {
    return null;
  }
  return window.location.origin && window.location.origin !== "null"
    ? window.location.origin
    : null;
}

function readWsUrl(): string | null {
  const origin = readBridgeOrigin();
  if (!origin) {
    return null;
  }
  try {
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function readWindowState(): Promise<DesktopWindowState> {
  const [isMaximized, isFullscreen] = await Promise.all([
    invokeCommand<boolean>("neolix:window:isMaximized"),
    invokeCommand<boolean>("neolix:window:isFullscreen"),
  ]);
  return { isMaximized, isFullscreen };
}

function cloneTab(tab: BrowserTab): BrowserTab {
  return { ...tab };
}

function cloneThreadBrowserState(state: ThreadBrowserState): ThreadBrowserState {
  return { ...state, tabs: state.tabs.map(cloneTab) };
}

function createRendererBrowserState() {
  const states = new Map<string, ThreadBrowserState>();
  const threadByWebContentsId = new Map<number, string>();
  const tabByWebContentsId = new Map<number, string>();
  const stateListeners = new Set<(state: ThreadBrowserState) => void>();
  const copyLinkListeners = new Set<(event: { threadId: string; url: string }) => void>();
  let nextTabNumber = 0;

  function createTab(url = BLANK_BROWSER_URL): BrowserTab {
    nextTabNumber += 1;
    return {
      id: `tab-${Date.now().toString(36)}-${nextTabNumber}`,
      url,
      title: url === BLANK_BROWSER_URL ? "New Tab" : url,
      status: "live",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastCommittedUrl: url === BLANK_BROWSER_URL ? null : url,
      lastError: null,
      runtimeSurface: "renderer",
    };
  }

  function ensureThread(threadId: string): ThreadBrowserState {
    let state = states.get(threadId);
    if (!state) {
      const tab = createTab();
      state = {
        threadId,
        version: 0,
        open: false,
        activeTabId: tab.id,
        tabs: [tab],
        lastError: null,
      };
      states.set(threadId, state);
    }
    return state;
  }

  function findTab(state: ThreadBrowserState, tabId?: string): BrowserTab | null {
    const wanted = tabId ?? state.activeTabId;
    return state.tabs.find((tab) => tab.id === wanted) ?? null;
  }

  function publish(state: ThreadBrowserState): ThreadBrowserState {
    state.version += 1;
    const snapshot = cloneThreadBrowserState(state);
    for (const listener of stateListeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer listener must not break the state machine.
      }
    }
    return snapshot;
  }

  function webContentsIdForTab(tabId: string): number | null {
    for (const [webContentsId, candidate] of tabByWebContentsId) {
      if (candidate === tabId) return webContentsId;
    }
    return null;
  }

  async function guestCommand(
    tabId: string,
    command: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    const webContentsId = webContentsIdForTab(tabId);
    if (webContentsId === null) {
      throw new Error("The browser tab is not attached to a page");
    }
    return invokeCommand("neolix:browser:guest-command", { webContentsId, command, ...extra });
  }

  function applyDestroyedGuestEvent(event: BrowserGuestEvent): void {
    const threadId = threadByWebContentsId.get(event.webContentsId);
    const tabId = tabByWebContentsId.get(event.webContentsId);
    threadByWebContentsId.delete(event.webContentsId);
    tabByWebContentsId.delete(event.webContentsId);
    if (!threadId || !tabId) return;
    const state = states.get(threadId);
    const tab = state?.tabs.find((candidate) => candidate.id === tabId);
    if (state && tab) {
      tab.status = "suspended";
      tab.isLoading = false;
      publish(state);
    }
  }

  function applyGuestEvent(event: BrowserGuestEvent): void {
    if (event.type === "destroyed") {
      applyDestroyedGuestEvent(event);
      return;
    }

    const threadId = threadByWebContentsId.get(event.webContentsId);
    const tabId = tabByWebContentsId.get(event.webContentsId);
    if (!threadId || !tabId) return;
    const state = states.get(threadId);
    const tab = state?.tabs.find((candidate) => candidate.id === tabId);
    if (!state || !tab) return;

    switch (event.type) {
      case "loading":
        tab.isLoading = event.isLoading === true;
        break;
      case "navigate":
        if (typeof event.url === "string") {
          tab.url = event.url;
          tab.lastCommittedUrl = event.url;
        }
        tab.canGoBack = event.canGoBack === true;
        tab.canGoForward = event.canGoForward === true;
        tab.lastError = null;
        break;
      case "title":
        if (typeof event.title === "string" && event.title.length > 0) {
          tab.title = event.title;
        }
        break;
      case "favicon":
        tab.faviconUrl = event.faviconUrl ?? null;
        break;
      case "error":
        tab.lastError = event.message ?? "The page could not be loaded";
        tab.isLoading = false;
        state.lastError = tab.lastError;
        break;
    }
    publish(state);
  }

  ipcRenderer.on("neolix:event:browser-guest", (_event, payload: unknown) => {
    if (typeof payload === "object" && payload !== null && "webContentsId" in payload) {
      applyGuestEvent(payload as BrowserGuestEvent);
    }
  });

  // Main routes target=_blank / OAuth popups back to the hosting renderer.
  ipcRenderer.on("neolix:event:browser-new-tab-request", (_event, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const request = payload as { sourceBrowserId?: unknown; url?: unknown };
    if (typeof request.sourceBrowserId !== "string" || typeof request.url !== "string") {
      return;
    }
    for (const state of states.values()) {
      const source = state.tabs.find((tab) => tab.id === request.sourceBrowserId);
      if (!source) continue;
      const tab = createTab(request.url);
      tab.openerTabId = source.id;
      state.tabs = [...state.tabs, tab];
      state.activeTabId = tab.id;
      publish(state);
      return;
    }
  });

  return {
    open(input: { threadId: string; initialUrl?: string }): ThreadBrowserState {
      const state = ensureThread(input.threadId);
      state.open = true;
      const tab = findTab(state);
      if (tab && typeof input.initialUrl === "string" && input.initialUrl.length > 0) {
        tab.url = input.initialUrl;
        tab.lastCommittedUrl = input.initialUrl;
      }
      return publish(state);
    },
    close(input: { threadId: string }): ThreadBrowserState {
      const state = ensureThread(input.threadId);
      state.open = false;
      state.activeTabId = null;
      state.tabs = [];
      state.lastError = null;
      return publish(state);
    },
    hide(_input: { threadId: string }): void {
      // The renderer removes its <webview>; state survives for the next mount.
    },
    getState(input: { threadId: string }): ThreadBrowserState {
      return cloneThreadBrowserState(ensureThread(input.threadId));
    },
    setPanelBounds(_input: unknown): void {
      // The web UI owns the inline webview bounds.
    },
    async attachWebview(input: {
      threadId: string;
      tabId: string;
      webContentsId: number;
    }): Promise<ThreadBrowserState> {
      const state = ensureThread(input.threadId);
      const tab = findTab(state, input.tabId);
      if (!tab) {
        throw new Error("Unknown browser tab");
      }
      await invokeCommand("neolix:browser:register-attached", {
        browserId: tab.id,
        workspaceId: input.threadId,
        webContentsId: input.webContentsId,
      } satisfies AttachedBrowserRegistration);
      threadByWebContentsId.set(input.webContentsId, input.threadId);
      tabByWebContentsId.set(input.webContentsId, tab.id);
      tab.status = "live";
      tab.lastError = null;
      return publish(state);
    },
    async detachWebview(input: {
      threadId: string;
      tabId: string;
      webContentsId: number;
    }): Promise<void> {
      threadByWebContentsId.delete(input.webContentsId);
      tabByWebContentsId.delete(input.webContentsId);
      await invokeCommand("neolix:browser:unregister-workspace-browser", input.tabId).catch(
        () => undefined,
      );
      const state = states.get(input.threadId);
      const tab = state?.tabs.find((candidate) => candidate.id === input.tabId);
      if (state && tab) {
        tab.status = "suspended";
        publish(state);
      }
    },
    async navigate(input: {
      threadId: string;
      tabId?: string;
      url: string;
    }): Promise<ThreadBrowserState> {
      const state = ensureThread(input.threadId);
      const tab = findTab(state, input.tabId);
      if (!tab) {
        throw new Error("Unknown browser tab");
      }
      tab.url = input.url;
      tab.lastCommittedUrl = input.url;
      tab.title = input.url;
      tab.lastError = null;
      try {
        await guestCommand(tab.id, "navigate", { url: input.url });
      } catch (error) {
        tab.lastError = error instanceof Error ? error.message : String(error);
      }
      return publish(state);
    },
    async reload(input: { threadId: string; tabId: string }): Promise<ThreadBrowserState> {
      const state = ensureThread(input.threadId);
      const tab = findTab(state, input.tabId);
      if (!tab) {
        throw new Error("Unknown browser tab");
      }
      await guestCommand(tab.id, "reload").catch(() => undefined);
      return publish(state);
    },
    async goBack(input: { threadId: string; tabId: string }): Promise<ThreadBrowserState> {
      const state = ensureThread(input.threadId);
      const tab = findTab(state, input.tabId);
      if (!tab) {
        throw new Error("Unknown browser tab");
      }
      await guestCommand(tab.id, "goBack").catch(() => undefined);
      return publish(state);
    },
    async goForward(input: { threadId: string; tabId: string }): Promise<ThreadBrowserState> {
      const state = ensureThread(input.threadId);
      const tab = findTab(state, input.tabId);
      if (!tab) {
        throw new Error("Unknown browser tab");
      }
      await guestCommand(tab.id, "goForward").catch(() => undefined);
      return publish(state);
    },
    newTab(input: { threadId: string; url?: string; activate?: boolean }): ThreadBrowserState {
      const state = ensureThread(input.threadId);
      const tab = createTab(input.url);
      state.tabs = [...state.tabs, tab];
      if (input.activate !== false || state.activeTabId === null) {
        state.activeTabId = tab.id;
      }
      return publish(state);
    },
    closeTab(input: { threadId: string; tabId: string }): ThreadBrowserState {
      const state = ensureThread(input.threadId);
      const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
      state.tabs = nextTabs.length > 0 ? nextTabs : [createTab()];
      if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
        state.activeTabId = state.tabs[0]?.id ?? null;
      }
      return publish(state);
    },
    selectTab(input: { threadId: string; tabId: string }): ThreadBrowserState {
      const state = ensureThread(input.threadId);
      if (state.tabs.some((tab) => tab.id === input.tabId)) {
        state.activeTabId = input.tabId;
      }
      return publish(state);
    },
    async openDevTools(input: { threadId: string; tabId: string }): Promise<void> {
      await guestCommand(input.tabId, "openDevTools").catch(() => undefined);
    },
    async copyLink(input: { threadId: string; tabId: string }): Promise<void> {
      const state = ensureThread(input.threadId);
      const tab = findTab(state, input.tabId);
      if (!tab || !tab.url) return;
      await guestCommand(tab.id, "copyLink", { url: tab.url });
      for (const listener of copyLinkListeners) {
        try {
          listener({ threadId: input.threadId, url: tab.url });
        } catch {
          // Ignore listener failures.
        }
      }
    },
    async copyScreenshotToClipboard(input: { threadId: string; tabId: string }): Promise<void> {
      await guestCommand(input.tabId, "copyScreenshot");
    },
    async captureScreenshot(input: {
      threadId: string;
      tabId: string;
    }): Promise<{ name: string; mimeType: "image/png"; sizeBytes: number; bytes: Uint8Array }> {
      const result = (await guestCommand(input.tabId, "capturePage")) as { png: Uint8Array };
      const bytes = result.png instanceof Uint8Array ? result.png : new Uint8Array(result.png);
      return {
        name: `browser-${input.tabId}.png`,
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        bytes,
      };
    },
    async capturePreview(input: { threadId: string; tabId: string }): Promise<string | null> {
      const result = (await guestCommand(input.tabId, "capturePage").catch(() => null)) as {
        dataUrl?: string;
      } | null;
      return result?.dataUrl ?? null;
    },
    onState(listener: (state: ThreadBrowserState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onBrowserCopyLink(listener: (event: { threadId: string; url: string }) => void): () => void {
      copyLinkListeners.add(listener);
      return () => copyLinkListeners.delete(listener);
    },
    onBrowserUseOpenPanelRequest(_listener: (request: { threadId: string }) => void): () => void {
      // Neolix has no agent-driven "open browser panel" bridge; the explicit
      // panel entry remains available, so this is a no-op subscription.
      return () => {};
    },
    clearProfile: (legacyBrowserIds: readonly string[]) =>
      invokeCommand("neolix:browser:clear-profile", [...legacyBrowserIds]),
  };
}

const rendererBrowser = createRendererBrowserState();
let cachedZoomFactor = 1;
void invokeCommand<number>("neolix:window:watch-zoom")
  .then((value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      cachedZoomFactor = value;
    }
    return undefined;
  })
  .catch(() => undefined);
ipcRenderer.on("neolix:event:zoom-factor", (_event, value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    cachedZoomFactor = value;
  }
});

const menuActionListeners = new Set<(action: string) => void>();
ipcRenderer.on("neolix:event:menu-action", (_event, action: unknown) => {
  if (typeof action === "string") {
    for (const listener of menuActionListeners) {
      try {
        listener(action);
      } catch {
        // Ignore listener failures.
      }
    }
  }
});
// Native notification clicks use the same action vocabulary as menus.
const notificationClickListeners = new Set<(data: Readonly<Record<string, unknown>>) => void>();
ipcRenderer.on("neolix:event:notification-click", (_event, payload: unknown) => {
  const data =
    typeof payload === "object" && payload !== null && "data" in payload
      ? (payload as { data?: Record<string, unknown> }).data
      : undefined;
  if (!data || typeof data !== "object") return;
  for (const listener of notificationClickListeners) {
    try {
      listener(data);
    } catch {
      // Ignore listener failures.
    }
  }
  const threadId = typeof data.threadId === "string" ? data.threadId : null;
  if (!threadId) return;
  for (const listener of menuActionListeners) {
    try {
      listener(`notification-open-thread:${threadId}`);
    } catch {
      // Ignore listener failures.
    }
  }
});

const quitConfirmationListeners = new Set<
  (request: { requestId: string; presentation: "native" | "in-app" }) => void
>();
ipcRenderer.on("neolix:event:quit-confirmation-request", (_event, request: unknown) => {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof (request as { requestId?: unknown }).requestId !== "string"
  ) {
    return;
  }
  const value = request as { requestId: string; presentation?: unknown };
  const payload = {
    requestId: value.requestId,
    presentation: value.presentation === "native" ? ("native" as const) : ("in-app" as const),
  };
  for (const listener of quitConfirmationListeners) {
    try {
      listener(payload);
    } catch {
      // Ignore listener failures.
    }
  }
});

const updateStateListeners = new Set<(state: DesktopUpdateState) => void>();
ipcRenderer.on("neolix:event:update-state", (_event, state: unknown) => {
  if (typeof state !== "object" || state === null) return;
  for (const listener of updateStateListeners) {
    try {
      listener(state as DesktopUpdateState);
    } catch {
      // Ignore listener failures.
    }
  }
});

const bridgePlatform = process.platform;
const customTitleBarSupported = bridgePlatform === "win32" || bridgePlatform === "linux";

const desktopBridge = {
  getWsUrl: readWsUrl,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  pickFolder: () => invokeCommand<string | null>("neolix:dialog:open", { directory: true }),
  saveFile: (input: Record<string, unknown>) =>
    invokeCommand<string | null>("neolix:desktop:save-file", input),
  confirm: (message: string) =>
    invokeCommand<boolean>("neolix:dialog:ask", message, {
      title: "Neox",
      cancelLabel: "Cancel",
      okLabel: "OK",
    }),
  setTheme: (theme: "light" | "dark" | "system") =>
    invokeCommand("neolix:desktop:set-theme", theme),
  getAppIcon: () => invokeCommand("neolix:desktop:get-app-icon"),
  setAppIcon: (icon: string) => invokeCommand("neolix:desktop:set-app-icon", icon),
  showContextMenu: (items: readonly unknown[], position?: { x: number; y: number }) =>
    invokeCommand<string | null>("neolix:desktop:context-menu", items, position),
  openExternal: (url: string) => invokeCommand<boolean>("neolix:desktop:open-external", url),
  showInFolder: (target: string) => invokeCommand("neolix:desktop:show-in-folder", target),
  shell: {
    showInFolder: (target: string) => invokeCommand("neolix:desktop:show-in-folder", target),
  },
  clipboard: {
    writeImagePngDataUrl: (dataUrl: string) =>
      invokeCommand<boolean>("neolix:desktop:write-clipboard-image", dataUrl),
  },
  windowControls: {
    minimize: () => invokeCommand("neolix:window:minimize"),
    toggleMaximize: async (): Promise<DesktopWindowState> => {
      await invokeCommand("neolix:window:toggleMaximize");
      return readWindowState();
    },
    close: () => invokeCommand("neolix:window:close"),
    getState: readWindowState,
    onState: (listener: (state: DesktopWindowState) => void): (() => void) => {
      let previous = "";
      const notify = () => {
        void readWindowState().then((state) => {
          const serialized = JSON.stringify(state);
          if (serialized === previous) return undefined;
          previous = serialized;
          listener(state);
          return undefined;
        });
      };
      const ipcListener = () => notify();
      ipcRenderer.on("neolix:window:resized", ipcListener);
      notify();
      return () => ipcRenderer.removeListener("neolix:window:resized", ipcListener);
    },
  },
  customTitleBar: {
    getState: () =>
      Promise.resolve({
        supported: customTitleBarSupported,
        preference: customTitleBarSupported,
        active: customTitleBarSupported,
        restartRequired: false,
      }),
    setPreference: (enabled: boolean) =>
      Promise.resolve({
        supported: customTitleBarSupported,
        preference: enabled,
        active: customTitleBarSupported,
        restartRequired: false,
      }),
    relaunch: () => invokeCommand("neolix:desktop:relaunch"),
  },
  uiMode: {
    getState: () => invokeCommand<DesktopUiModeState>("neolix:desktop:ui-mode-state"),
    setMode: (mode: "native" | "web") => invokeCommand("neolix:desktop:set-ui-mode", mode),
  },
  keepAwake: {
    getState: () => invokeCommand<DesktopKeepAwakeState>("neolix:desktop:keep-awake-state"),
    setEnabled: (enabled: boolean) =>
      invokeCommand<DesktopKeepAwakeState>("neolix:desktop:set-keep-awake-enabled", enabled),
    setRemoteAccessAllowed: (allowed: boolean) =>
      invokeCommand<DesktopKeepAwakeState>("neolix:desktop:set-remote-access-allowed", allowed),
  },
  safariAccess: {
    getInfo: () => invokeCommand<DesktopSafariAccessInfo>("neolix:safari-access:info"),
    openSettings: () => invokeCommand<boolean>("neolix:safari-access:open-settings"),
    revealApp: () => invokeCommand<boolean>("neolix:safari-access:reveal-app"),
  },
  osPermissions: {
    getState: () => invokeCommand<DesktopOsPermissionSnapshot>("neolix:os-permissions:state"),
    request: (kind: DesktopOsPermissionKind) =>
      invokeCommand<DesktopOsPermissionState>("neolix:os-permissions:request", kind),
    openSettings: (kind: DesktopOsPermissionKind) =>
      invokeCommand<boolean>("neolix:os-permissions:open-settings", kind),
  },
  onMenuAction: (listener: (action: string) => void): (() => void) => {
    menuActionListeners.add(listener);
    return () => menuActionListeners.delete(listener);
  },
  onNotificationClick: (
    listener: (data: Readonly<Record<string, unknown>>) => void,
  ): (() => void) => {
    notificationClickListeners.add(listener);
    return () => notificationClickListeners.delete(listener);
  },
  onQuitConfirmationRequest: (
    listener: (request: { requestId: string; presentation: "native" | "in-app" }) => void,
  ): (() => void) => {
    quitConfirmationListeners.add(listener);
    return () => quitConfirmationListeners.delete(listener);
  },
  replyQuitConfirmation: (response: DesktopQuitConfirmationResponse): void => {
    ipcRenderer.send("neolix:quit-confirmation-response", response);
  },
  getZoomFactor: () => cachedZoomFactor,
  onZoomFactorChange: (listener: (zoomFactor: number) => void): (() => void) => {
    const ipcListener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        listener(value);
      }
    };
    ipcRenderer.on("neolix:event:zoom-factor", ipcListener);
    return () => ipcRenderer.removeListener("neolix:event:zoom-factor", ipcListener);
  },
  getUpdateState: () => invokeCommand<DesktopUpdateState>("neolix:desktop:update-state"),
  checkForUpdates: () => invokeCommand<DesktopUpdateState>("neolix:desktop:check-updates"),
  downloadUpdate: () => invokeCommand<DesktopUpdateActionResult>("neolix:desktop:download-update"),
  installUpdate: () => invokeCommand<DesktopUpdateActionResult>("neolix:desktop:install-update"),
  onUpdateState: (listener: (state: DesktopUpdateState) => void): (() => void) => {
    updateStateListeners.add(listener);
    return () => updateStateListeners.delete(listener);
  },
  notifications: {
    isSupported: () => invokeCommand<boolean>("neolix:notification:isSupported"),
    show: (input: {
      title: string;
      body?: string;
      silent?: boolean;
      suppressWhenForeground?: boolean;
      threadId?: string;
    }) => {
      if (
        input.suppressWhenForeground === true &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        return Promise.resolve(false);
      }
      return invokeCommand<boolean>("neolix:notification:send", {
        title: input.title,
        body: input.body,
        data: {
          ...(input.threadId ? { threadId: input.threadId } : {}),
          silent: input.silent,
        },
      });
    },
  },
  browser: rendererBrowser,
};

contextBridge.exposeInMainWorld("desktopBridge", desktopBridge);

contextBridge.exposeInMainWorld("neolixDesktop", {
  platform: process.platform,
  windowChromeMode: readWindowChromeMode(),
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("neolix:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("neolix:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("neolix:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`neolix:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`neolix:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("neolix:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("neolix:window:minimize"),
      close: () => ipcRenderer.invoke("neolix:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("neolix:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("neolix:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("neolix:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("neolix:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("neolix:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("neolix:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("neolix:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("neolix:window:setBadgeCount", count),
    }),
  },
  panel: {
    hide: () => ipcRenderer.invoke("neolix:panel:hide"),
    openMain: () => ipcRenderer.invoke("neolix:panel:openMain"),
    openAgent: (target: { serverId: string; agentId: string }) =>
      ipcRenderer.invoke("neolix:panel:openAgent", target),
    openThread: (threadId: string) => ipcRenderer.invoke("neolix:panel:openThread", threadId),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("neolix:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("neolix:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("neolix:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("neolix:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("neolix:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("neolix:opener:openUrl", url),
    openAgentLink: (url: string) => ipcRenderer.invoke("neolix:opener:openAgentLink", url),
  },
  editor: {
    listTargets: (input?: { workspacePath?: string }) =>
      ipcRenderer.invoke("neolix:editor:listTargets", input),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("neolix:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("neolix:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("neolix:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("neolix:browser:set-shortcut-policy", input),
    profilePartition: NEOLIX_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("neolix:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("neolix:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("neolix:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("neolix:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("neolix:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("neolix:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("neolix:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("neolix:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("neolix:browser:copy-element", payload),
  },
});
