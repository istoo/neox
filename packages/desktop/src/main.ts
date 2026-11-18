// Must stay the first import: it traces every later require when enabled.
import { traceStartup } from "./diagnostics/startup-trace.js";
import { protectConsoleStreams } from "./diagnostics/console-streams.js";
protectConsoleStreams();

process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  applyDesktopWindowChromeMode,
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  resolveWindowBounds,
  setupWindowResizeEvents,
  setupWindowStatePersistence,
  setupDefaultContextMenu,
  setupDragDropPrevention,
  buildStandardContextMenuItems,
} from "./window/window-manager.js";
import { setupDarwinCompositorWatchdog } from "./window/compositor-watchdog/index.js";
import { showWindowWhenReady } from "./window/show-when-ready.js";
import { resolveDesktopWindowChromeMode, windowChromeModeArgument } from "./window/chrome.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { createAgentLinkOpener, createExternalUrlOpener } from "./features/opener.js";
import { createBrowserCaptureService } from "./features/browser-capture.js";
import { registerEditorTargetHandlers } from "./features/editor-targets/ipc.js";
import { resolveAppIconPath } from "./features/stamped-icon.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  getNeolixBrowserIdForWebContents,
  getNeolixBrowserWebContentsForHostWindow,
  getNeolixBrowserWebviewRegistry,
  listRegisteredNeolixBrowserIds,
  isNeolixBrowserWebviewAttach,
  prepareNeolixBrowserWebContents,
  PendingBrowserWindowOpenRequests,
  registerBrowserWebviewNavigationGuards,
  unregisterNeolixBrowserFromHost,
  registerAttachedNeolixBrowser,
  setWorkspaceActiveNeolixBrowserId,
  unregisterNeolixBrowserHost,
} from "./features/browser-webviews/index.js";
import {
  clearNeolixBrowserProfile,
  getLegacyNeolixBrowserProfileSession,
  NEOLIX_BROWSER_PROFILE_PARTITION,
  getNeolixBrowserProfileSession,
  getNeolixBrowserProfileSessions,
  listNeolixBrowserProfileGuests,
  readLegacyNeolixBrowserIds,
  readLegacyNeolixBrowserIdsFromPartitionDirectory,
} from "./features/browser-profile.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import {
  createDesktopWindowOwner,
  type DesktopWindowOwner,
  type OwnedDesktopWindow,
} from "./window/desktop-window-owner.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { applySystemPreferences } from "./system/preferences.js";
import { shouldHideWindowOnClose } from "./system/preferences.js";
import {
  getAutostartState,
  launchedHidden,
  refreshAutostart,
  setAutostart,
  type AutostartHost,
  type AutostartState,
} from "./system/autostart.js";
import {
  hasPanelArg,
  HIDDEN_ARG,
  parseCliControlRequest,
  writeCliControlReply,
  type CliControlReply,
  type CliControlRequest,
} from "./system/cli-control.js";
import {
  applyTraySettings,
  currentTrayLanguage,
  installDesktopTray,
  isDesktopTrayInstalled,
  setTrayUsage,
  setTrayUsageRefresher,
} from "./system/tray-manager.js";
import { startTrayUsagePolling } from "./system/tray-usage-poller.js";
import { createDaemonTrayUsageClient } from "./system/tray-usage-client.js";
import { promises as nodeFs } from "node:fs";
import {
  clearPanelClicks,
  clickedOutside,
  currentPanelPlacement,
  isHyprland,
  placePanelWindow,
  reportClicks,
  stopReportingClicks,
  watchClicks,
} from "./system/hyprland-panel.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  resolveTrayUsageTarget,
  startDesktopDaemonFromTray,
  stopDesktopDaemon,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import { createQuitConfirmationBroker } from "./window/quit-confirmation.js";
import { registerBrowserAutomationIpc } from "./features/browser-automation/ipc.js";
import { BrowserKeyboard } from "./features/browser-keyboard/index.js";
import { installAppUpdateOnQuit } from "./features/auto-updater.js";
import { checkForAppUpdate, downloadAndInstallUpdate } from "./features/auto-updater.js";
import { applyUpdateProxy } from "./features/update-proxy.js";
import {
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  type AgentDeepLinkTarget,
} from "@neolix/protocol/agent-deep-link";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";
import { resolveUserDataDir } from "./user-data.js";
import {
  buildDesktopWebStartingUrl,
  buildDesktopWebStartupErrorUrl,
  DESKTOP_WEB_STARTUP_RETRY_URL,
  normalizeDesktopWebDevUrl,
  type DesktopWebStartupLocale,
  resolveDesktopWebBaseUrl,
  resolveDesktopWebStartupLocale,
  waitForDesktopWebReady,
} from "./desktop-web/startup.js";
import { registerDesktopWebIpc } from "./features/desktop-web-ipc.js";
import { registerOsPermissionsIpc } from "./features/os-permissions.js";
import {
  forwardBrowserGuestEvents,
  registerDesktopWebBrowserGuestIpc,
} from "./features/browser-webviews/desktop-web-guest.js";
import type { DesktopAppIconName } from "./settings/desktop-settings.js";
import { resolveChosenAppIconPath } from "./features/app-icon-choice.js";
import { resolveDesktopDaemonStatus } from "./daemon/daemon-manager.js";

traceStartup("main: imports done");
const NEOLIX_DEBUG = process.env.NEOLIX_DEBUG === "1";
const DISABLE_SINGLE_INSTANCE_LOCK = process.env.NEOLIX_DISABLE_SINGLE_INSTANCE_LOCK === "1";
const APP_NAME = process.env.NEOLIX_TEST_APP_NAME?.trim() || "Neox";
const DESKTOP_WINDOW_CHROME_MODE = resolveDesktopWindowChromeMode({
  platform: process.platform,
  override: process.env.NEOLIX_DESKTOP_WINDOW_CONTROLS,
  isPackaged: app.isPackaged,
});
const UPDATE_QUIT_DEADLINE_MS = 5_000;
const pendingBrowserWindowOpenRequests = new PendingBrowserWindowOpenRequests();
const agentNavigationInbox = new AgentNavigationInbox();

// Where the daemon serves the web UI. Windows consult it at creation time, and
// the startup error page keeps the failure reason for Retry and log reporting.
let desktopWebBaseUrl: string | null = null;
let desktopWebStartupFailure: string | null = null;
let desktopWebStartupInFlight = false;
/** True until the first probe settles; windows show the waiting page meanwhile. */
let desktopWebStartupPending = true;
// The route each shell window should return to when Retry reloads it.
const shellWindowRoutes = new Map<number, string>();

// A second-instance launch can arrive before the packaged protocol handler,
// IPC handlers, and first window exist. Wait for full bootstrap, not just
// app.whenReady(), before delivering navigation to the renderer.
let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});
let bootstrapIsComplete = false;

traceStartup("main: setting app name");
app.setName(APP_NAME);
traceStartup("main: app name set");
// app.setName() names Electron's default userData directory after the app,
// which is <appData>/Neox. Resolve the directory explicitly before anything
// reads userData so dev worktrees stay isolated.
//
// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
const forcedUserDataDir = process.env.NEOLIX_ELECTRON_USER_DATA_DIR?.trim();
if (!forcedUserDataDir && !app.isPackaged) {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "neolix") keeps the same directory as packaged builds.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      }).trim(),
    );
    const isWorktree = path.resolve(topLevel, ".git") !== commonDir;
    if (!isWorktree) {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

traceStartup("main: resolving userData");
const userDataDir = resolveUserDataDir({
  forcedDir: forcedUserDataDir ?? null,
  isPackaged: app.isPackaged,
  devWorktreeName,
  appDataDir: () => app.getPath("appData"),
});
traceStartup(`main: setting userData ${userDataDir}`);
app.setPath("userData", userDataDir);
traceStartup("main: first log write");
if (forcedUserDataDir) {
  log.info("[dev-user-data] forced userData dir:", forcedUserDataDir);
} else if (devWorktreeName) {
  log.info("[worktree] isolated userData for worktree:", devWorktreeName);
}

traceStartup("main: userData set");
log.info("[desktop] app startup", {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
});

interface AttachedBrowserInput {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

function readAttachedBrowserInput(input: unknown): AttachedBrowserInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.browserId !== "string" || record.browserId.trim().length === 0) {
    return null;
  }
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  if (
    typeof record.webContentsId !== "number" ||
    !Number.isInteger(record.webContentsId) ||
    record.webContentsId <= 0
  ) {
    return null;
  }
  return {
    browserId: record.browserId.trim(),
    workspaceId: record.workspaceId.trim(),
    webContentsId: record.webContentsId,
  };
}

function readActiveBrowserInput(
  input: unknown,
): { workspaceId: string; browserId: string | null } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  const browserId = typeof record.browserId === "string" ? record.browserId.trim() : null;
  return { workspaceId: record.workspaceId.trim(), browserId: browserId || null };
}

const browserKeyboard = new BrowserKeyboard(getNeolixBrowserWebviewRegistry());
browserKeyboard.registerIpc();

function showBrowserWebviewContextMenu(
  win: BrowserWindow,
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const menu = Menu.buildFromTemplate([
    ...buildStandardContextMenuItems(contents, params),
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          {
            label: "Inspect Element",
            click: () => {
              log.info("[browser-devtools] inspect-element.request", {
                webContentsId: contents.id,
                browserId: getNeolixBrowserIdForWebContents(contents),
                x: params.x,
                y: params.y,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
              contents.openDevTools({ mode: "detach" });
              contents.inspectElement(params.x, params.y);
              log.info("[browser-devtools] inspect-element.done", {
                webContentsId: contents.id,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
            },
          },
        ]),
  ]);
  menu.popup({ window: win });
}

function getBrowserPopupWindowOptions(
  mainWindow: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: mainWindow,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: NEOLIX_BROWSER_PROFILE_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };
}

function installBrowserWindowOpenHandler(input: {
  contents: Electron.WebContents;
  sourceContents: Electron.WebContents;
  mainWindow: BrowserWindow;
}): void {
  const { contents, sourceContents, mainWindow } = input;

  contents.setWindowOpenHandler(({ url, disposition, frameName, features, postBody }) => {
    const decision = decideBrowserWindowOpenRequest({
      url,
      disposition,
      frameName,
      features,
      hasPostBody: postBody !== undefined && postBody !== null,
    });

    if (decision.kind === "deny") {
      return { action: "deny" };
    }
    if (decision.kind === "popup") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: getBrowserPopupWindowOptions(mainWindow),
      };
    }

    const sourceBrowserId = getNeolixBrowserIdForWebContents(sourceContents);
    if (sourceBrowserId) {
      mainWindow.webContents.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
        sourceBrowserId,
        url: decision.url,
      });
    } else {
      pendingBrowserWindowOpenRequests.add(sourceContents.id, decision.url);
    }
    return { action: "deny" };
  });

  contents.on("did-create-window", (popupWindow) => {
    const popupContents = popupWindow.webContents;
    registerBrowserWebviewNavigationGuards(popupContents);
    popupContents.on("context-menu", (_event, params) => {
      showBrowserWebviewContextMenu(popupWindow, popupContents, params);
    });
    installBrowserWindowOpenHandler({
      contents: popupContents,
      sourceContents,
      mainWindow,
    });
  });
}

// Allow users to pass Chromium flags via NEOLIX_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.NEOLIX_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

if (process.platform === "linux") {
  // Keep the desktop/dock identity independent of the wrapped Electron filename.
  app.setDesktopName("Neox.desktop");
  if (!app.commandLine.hasSwitch("class")) app.commandLine.appendSwitch("class", "Neox");
  log.info("[linux-sandbox]", {
    enabled: !app.commandLine.hasSwitch("no-sandbox"),
    reason: process.env.NEOLIX_DESKTOP_SANDBOX_REASON ?? "Chromium default",
  });
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});
let pendingAgentNavigation = parseAgentDeepLinkFromArgv(process.argv);

// Each window pulls its own pending open-project path on mount, keyed by
// webContents id, so deep-linked windows (second-instance launches, the
// in-app "Open in new window" action) land on the right project without
// racing a global.
let desktopWindowOwner: DesktopWindowOwner<AgentDeepLinkTarget>;

if (NEOLIX_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("neolix:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = desktopWindowOwner.takePendingProject(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

ipcMain.handle("neolix:agent-navigation:ready", (event) => {
  return agentNavigationInbox.windowReady(event.sender.id);
});

// The new renderer lists the running chats and answers quit requests itself;
// older windows never answer, so the broker times out and the native dialog
// below still guards the quit.
let quitConfirmationTargetId: number | null = null;
let quitConfirmationTargetGone = false;
let detachQuitConfirmationTarget: (() => void) | null = null;
const quitConfirmationBroker = createQuitConfirmationBroker({
  renderer: {
    send: (request) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) {
        throw new Error("No window is open to answer the quit prompt.");
      }
      detachQuitConfirmationTarget?.();
      const contents = win.webContents;
      quitConfirmationTargetId = contents.id;
      quitConfirmationTargetGone = false;
      // A window that closes or crashes while its prompt is open would otherwise
      // leave the request pending, and every later quit would be refused.
      const onGone = () => {
        quitConfirmationTargetGone = true;
        quitConfirmationBroker.handleRendererGone();
      };
      contents.once("destroyed", onGone);
      contents.once("render-process-gone", onGone);
      detachQuitConfirmationTarget = () => {
        contents.removeListener("destroyed", onGone);
        contents.removeListener("render-process-gone", onGone);
      };
      contents.send("neolix:event:quit-confirmation-request", request);
    },
    isAlive: () => {
      if (quitConfirmationTargetId === null || quitConfirmationTargetGone) return false;
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === quitConfirmationTargetId,
      );
      return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed());
    },
  },
});
ipcMain.on("neolix:quit-confirmation-response", (event, response: unknown) => {
  if (event.sender.id !== quitConfirmationTargetId) return;
  quitConfirmationBroker.handleResponse(response);
});

ipcMain.handle("neolix:browser:register-attached", (event, rawInput: unknown) => {
  const input = readAttachedBrowserInput(rawInput);
  if (!input) {
    throw new Error("Invalid attached browser registration");
  }
  const registered = registerAttachedNeolixBrowser({
    ...input,
    sender: event.sender,
    profileSession: getNeolixBrowserProfileSession(session),
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) {
    throw new Error("Attached browser registration was rejected");
  }
  const guest = webContents.fromId(input.webContentsId);
  if (!guest) {
    throw new Error("Attached browser guest disappeared after registration");
  }
  browserKeyboard.attach({ contents: guest, hostContents: event.sender });
  forwardBrowserGuestEvents(guest, event.sender);
  log.info("[browser-webview] registered", {
    browserId: input.browserId,
    webContentsId: input.webContentsId,
    registeredBrowserIds: listRegisteredNeolixBrowserIds(),
  });
  for (const url of pendingBrowserWindowOpenRequests.take(input.webContentsId)) {
    event.sender.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
      sourceBrowserId: input.browserId,
      url,
    });
  }
  return true;
});

ipcMain.handle("neolix:browser:unregister-workspace-browser", async (event, browserId: unknown) => {
  if (typeof browserId === "string" && browserId.trim().length > 0) {
    const normalizedBrowserId = browserId.trim();
    const hasOtherHost = getNeolixBrowserWebviewRegistry().hasBrowserInOtherHostWindow(
      event.sender.id,
      normalizedBrowserId,
    );
    unregisterNeolixBrowserFromHost(event.sender.id, normalizedBrowserId);
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    const legacyProfile = hasOtherHost
      ? null
      : getLegacyNeolixBrowserProfileSession(session, normalizedBrowserId);
    if (legacyProfile) {
      try {
        await clearNeolixBrowserProfile({
          profileSessions: [legacyProfile],
          listGuests: () => [],
          logReloadError: () => {},
        });
      } catch (error) {
        log.warn("[browser-profile] failed to clear legacy tab profile", {
          browserId: normalizedBrowserId,
          error,
        });
      }
    }
  }
});

ipcMain.handle("neolix:browser:set-workspace-active-browser", (event, rawInput: unknown) => {
  const input = readActiveBrowserInput(rawInput);
  if (input) {
    setWorkspaceActiveNeolixBrowserId({ ...input, hostWebContentsId: event.sender.id });
  }
});

ipcMain.handle("neolix:browser:focus", (event, browserId: unknown): boolean => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    return false;
  }
  const contents = getNeolixBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    return false;
  }
  contents.focus();
  return true;
});

ipcMain.handle("neolix:browser:open-devtools", (event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    const result = {
      ok: false,
      reason: "invalid-browser-id",
      browserId,
      registeredBrowserIds: listRegisteredNeolixBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.invalid", result);
    return result;
  }
  const contents = getNeolixBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    const result = {
      ok: false,
      reason: "browser-webcontents-not-found",
      browserId,
      registeredBrowserIds: listRegisteredNeolixBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.not-found", result);
    return result;
  }
  log.info("[browser-devtools] open-devtools.request", {
    browserId,
    webContentsId: contents.id,
    isDestroyed: contents.isDestroyed(),
    isDevToolsOpened: contents.isDevToolsOpened(),
    registeredBrowserIds: listRegisteredNeolixBrowserIds(),
  });
  contents.openDevTools({ mode: "detach" });
  const result = {
    ok: true,
    reason: "opened",
    browserId,
    webContentsId: contents.id,
    isDevToolsOpened: contents.isDevToolsOpened(),
  };
  log.info("[browser-devtools] open-devtools.done", result);
  return result;
});

/**
 * Retired native-app tabs each had their own `persist:neolix-browser-<id>`
 * partition; nothing names them any more, so read the directories Chromium left
 * under `Partitions/`. Missing or unreadable means no legacy profile to clear.
 */
function legacyBrowserIdsOnDisk(): string[] {
  try {
    return readLegacyNeolixBrowserIdsFromPartitionDirectory(
      readdirSync(path.join(app.getPath("userData"), "Partitions")),
    );
  } catch {
    return [];
  }
}

ipcMain.handle("neolix:browser:clear-profile", async (_event, rawLegacyBrowserIds: unknown) => {
  const profileSessions = getNeolixBrowserProfileSessions(
    session,
    readLegacyNeolixBrowserIds([
      ...readLegacyNeolixBrowserIds(rawLegacyBrowserIds),
      ...legacyBrowserIdsOnDisk(),
    ]),
  );
  const profileSession = profileSessions[0];
  await clearNeolixBrowserProfile({
    profileSessions,
    listGuests: () =>
      listNeolixBrowserProfileGuests({
        profileSession,
        webContents: webContents.getAllWebContents(),
      }),
    logReloadError: (webContentsId, error) => {
      log.warn("[browser-profile] failed to reload guest", { webContentsId, error });
    },
  });
});

const browserCapture = createBrowserCaptureService<Electron.NativeImage>({
  findGuest: getNeolixBrowserWebContentsForHostWindow,
  decodeImage: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
  clipboard: {
    write: async ({ text, image }) => {
      const items: Record<string, string | Blob> = {};
      if (text) items["text/plain"] = text;
      if (image) {
        const png = image.toPNG();
        const bytes = new Uint8Array(png.byteLength);
        bytes.set(png);
        items["image/png"] = new Blob([bytes], { type: "image/png" });
      }
      await clipboard.write([new ClipboardItem(items)]);
    },
  },
  warn: (event, details) => log.warn(`[browser-capture] ${event}`, details),
});

ipcMain.handle("neolix:browser:capture-element", (event, browserId: unknown, rect: unknown) =>
  browserCapture.capture({ browserId, hostWebContentsId: event.sender.id, rect }),
);

ipcMain.handle("neolix:browser:copy-element", (_event, payload: unknown) =>
  browserCapture.copy(payload),
);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getBrowserKeyboardPreloadPath(): string {
  return path.join(__dirname, "features", "browser-keyboard", "guest-preload.js");
}

function getWindowIconCandidates(): string[] {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(process.resourcesPath, "icon.png"),
      ];
    }
    return [path.join(process.resourcesPath, "icon.png")];
  }
  if (process.platform === "win32") {
    return [
      path.resolve(__dirname, "../assets/icon-dev.png"),
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [
    path.resolve(__dirname, "../assets/icon-dev.png"),
    path.resolve(__dirname, "../assets/icon.png"),
  ];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getDevBuildLabel(): string | null {
  if (app.isPackaged) {
    return null;
  }
  return process.env.EXPO_PUBLIC_NEOLIX_DEV_BUILD_LABEL?.trim() || null;
}

let cachedEffectiveIconPath: string | null = null;

async function getEffectiveAppIconPath(): Promise<string | null> {
  if (cachedEffectiveIconPath !== null) {
    return cachedEffectiveIconPath;
  }
  const baseIconPath = getWindowIconPath();
  if (app.isPackaged || !baseIconPath) {
    cachedEffectiveIconPath = baseIconPath;
    return baseIconPath;
  }
  const devLabel = getDevBuildLabel();
  cachedEffectiveIconPath = await resolveAppIconPath({
    isPackaged: false,
    baseIconPath,
    devLabel,
    cacheDir: app.getPath("userData"),
  });
  return cachedEffectiveIconPath;
}

async function applyAppIcon(): Promise<void> {
  appIconChoice = (await getDesktopSettingsStore().get()).appIcon;
  // Packaged apps keep the bundle icon and its macOS system appearance unless a variant is chosen.
  if (process.platform !== "darwin" || (app.isPackaged && appIconChoice === "default")) {
    return;
  }

  const iconPath = await getCurrentAppIconPath();
  if (!iconPath) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

let appIconChoice: DesktopAppIconName = "default";

/** The Appearance › App icon variant, or the bundle (dev-stamped) icon for `default`. */
async function getCurrentAppIconPath(): Promise<string | null> {
  return (
    resolveChosenAppIconPath({
      name: appIconChoice,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      assetsDir: path.resolve(__dirname, "../assets"),
      exists: existsSync,
    }) ?? (await getEffectiveAppIconPath())
  );
}

/** Saves and shows a new Appearance › App icon choice: the Dock on macOS, every window elsewhere. */
async function setAppIconChoice(name: DesktopAppIconName): Promise<void> {
  await getDesktopSettingsStore().patch({ appIcon: name });
  appIconChoice = name;
  const iconPath = await getCurrentAppIconPath();
  if (!iconPath) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(icon);
    return;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setIcon(icon);
  }
}

// Work areas with the primary display first, so window-state clamping treats
// it as the fallback. getAllDisplays() order is not guaranteed to lead with it.
function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

/** The Settings language when one is picked, else the system locale, for the shell pages. */
async function desktopWebLocale(): Promise<DesktopWebStartupLocale> {
  const preference = await getDesktopSettingsStore()
    .get()
    .then((settings) => settings.language)
    .catch(() => "");
  return resolveDesktopWebStartupLocale(preference, app.getLocale());
}

async function desktopWebStartupErrorPageUrl(): Promise<string> {
  return buildDesktopWebStartupErrorUrl({
    reason: desktopWebStartupFailure ?? "The local server is not available.",
    logPath: log.transports.file.getFile().path,
    locale: await desktopWebLocale(),
  });
}

function failDesktopWebStartup(reason: string): void {
  desktopWebStartupPending = false;
  desktopWebBaseUrl = null;
  desktopWebStartupFailure = reason;
  log.warn("[desktop-web] startup failed", reason);
}

/**
 * Start the daemon that serves the web UI and wait for it to answer. The
 * NEOLIX_DESKTOP_WEB_URL override skips both, for a vite dev server.
 */
async function startDesktopWebRenderer(): Promise<void> {
  desktopWebStartupPending = true;
  desktopWebBaseUrl = null;
  desktopWebStartupFailure = null;

  const devUrl = process.env.NEOLIX_DESKTOP_WEB_URL?.trim();
  if (devUrl) {
    const normalized = normalizeDesktopWebDevUrl(devUrl);
    if (normalized === null) {
      failDesktopWebStartup(`NEOLIX_DESKTOP_WEB_URL is not an http(s) URL: ${devUrl}`);
      return;
    }
    desktopWebBaseUrl = normalized;
    desktopWebStartupPending = false;
    log.info("[desktop-web] using the development server", normalized);
    return;
  }

  try {
    // An explicit address means the caller owns that daemon (dev/tests), so do
    // not start or restart the managed one.
    let daemonAddress = process.env.NEOLIX_DESKTOP_DAEMON?.trim() || null;
    if (!daemonAddress) {
      await startDesktopDaemonFromTray().catch((error) => {
        log.warn("[desktop-web] desktop daemon start failed", error);
      });
      // A daemon that is still starting already knows where it will listen;
      // the readiness poll below waits for it.
      const status = await resolveDesktopDaemonStatus();
      daemonAddress =
        status.status === "running" || status.status === "starting" ? status.listen : null;
    }
    if (!daemonAddress) {
      failDesktopWebStartup(
        "No local daemon address is available. Start the daemon or set NEOLIX_DESKTOP_DAEMON.",
      );
      return;
    }

    const baseUrl = resolveDesktopWebBaseUrl(daemonAddress);
    if (baseUrl === null) {
      failDesktopWebStartup(
        `The daemon listens on "${daemonAddress}", which a desktop window cannot load. ` +
          "Point NEOLIX_DESKTOP_DAEMON at a host:port address.",
      );
      return;
    }

    const ready = await waitForDesktopWebReady({
      baseUrl,
      log: (line) => log.info("[desktop-web]", line),
    });
    if (!ready.ok) {
      failDesktopWebStartup(ready.reason);
      return;
    }
    desktopWebBaseUrl = baseUrl;
    desktopWebStartupPending = false;
    log.info("[desktop-web] web interface ready", baseUrl);
  } catch (error) {
    failDesktopWebStartup(error instanceof Error ? error.message : String(error));
  }
}

/** Loads the app, the waiting page, or the startup error page. */
async function loadShellContent(win: BrowserWindow, route: string): Promise<void> {
  shellWindowRoutes.set(win.webContents.id, route);
  if (desktopWebStartupPending) {
    await win.loadURL(buildDesktopWebStartingUrl({ locale: await desktopWebLocale() }));
    return;
  }
  if (desktopWebBaseUrl === null) {
    await win.loadURL(await desktopWebStartupErrorPageUrl());
    return;
  }
  try {
    await win.loadURL(new URL(`#${route}`, desktopWebBaseUrl).toString());
  } catch (error) {
    log.error("[desktop-web] failed to load the web interface", error);
    desktopWebStartupFailure = error instanceof Error ? error.message : String(error);
    await win.loadURL(await desktopWebStartupErrorPageUrl());
  }
}

/** Reloads every shell window at its recorded route after a startup transition. */
async function reloadShellWindows(): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // Quick-panel and other renderers never register a shell route; leave them alone.
    const route = shellWindowRoutes.get(win.webContents.id);
    if (route === undefined) continue;
    await loadShellContent(win, route).catch((error) => {
      log.warn("[desktop-web] could not reload a window", error);
    });
  }
}

/** Retry runs the daemon probe again, then reloads every shell window. */
async function retryDesktopWebStartup(): Promise<void> {
  if (desktopWebStartupInFlight) {
    return;
  }
  desktopWebStartupInFlight = true;
  try {
    log.info("[desktop-web] retrying startup");
    const startup = startDesktopWebRenderer();
    // The windows still show the error page; put them back on the waiting page
    // while the probe runs. A fast probe supersedes this load.
    await reloadShellWindows();
    await startup;
    await reloadShellWindows();
  } finally {
    desktopWebStartupInFlight = false;
  }
}

/** The error page's Retry link is a normal anchor; cancel it and retry here. */
function installStartupRecoveryNavigation(win: BrowserWindow): void {
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== DESKTOP_WEB_STARTUP_RETRY_URL) return;
    event.preventDefault();
    void retryDesktopWebStartup();
  });
}

async function createWindow(
  options: {
    initialRoute?: string | null;
    restoreWindowState?: boolean;
    onCreated?: (webContentsId: number) => void;
    onClosed?: (webContentsId: number) => void;
  } = {},
): Promise<BrowserWindow> {
  const iconPath = await getCurrentAppIconPath();
  const systemTheme = resolveSystemWindowTheme();

  // Only the first window of a session restores and persists saved geometry.
  // Additional windows (⌘N, second-instance, "Open in new window") open at the
  // default size and let the OS cascade them, so they neither stack on top of
  // the restored window nor fight over the single window-state store.
  const restoreWindowState = options.restoreWindowState ?? false;
  const windowStateStore = restoreWindowState
    ? createWindowStateStore({ userDataPath: app.getPath("userData") })
    : null;
  const savedWindowState = windowStateStore ? await windowStateStore.load() : null;
  const restoredWindowState = savedWindowState
    ? clampWindowStateToWorkAreas(savedWindowState, getWorkAreasPrimaryFirst())
    : null;

  const title = devWorktreeName ? `${APP_NAME} (${devWorktreeName})` : APP_NAME;
  const mainWindow = new BrowserWindow({
    title,
    ...resolveWindowBounds(restoredWindowState),
    show: false,
    backgroundColor: getWindowBackgroundColor(systemTheme),
    ...(iconPath ? { icon: iconPath } : {}),
    ...getMainWindowChromeOptions({
      mode: DESKTOP_WINDOW_CHROME_MODE,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      additionalArguments: [windowChromeModeArgument(DESKTOP_WINDOW_CHROME_MODE)],
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  applyDesktopWindowChromeMode({ win: mainWindow, mode: DESKTOP_WINDOW_CHROME_MODE });
  installStartupRecoveryNavigation(mainWindow);

  const webContentsId = mainWindow.webContents.id;
  options.onCreated?.(webContentsId);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) {
      agentNavigationInbox.windowLoading(webContentsId);
    }
  });
  mainWindow.on("closed", () => {
    options.onClosed?.(webContentsId);
    shellWindowRoutes.delete(webContentsId);
    agentNavigationInbox.removeWindow(webContentsId);
    unregisterNeolixBrowserHost(webContentsId);
    browserKeyboard.detachHost(webContentsId);
  });
  // Lightweight mode off keeps a closed window hidden instead of freeing its
  // renderer; the tray brings it back without a reload (myna's setting).
  mainWindow.on("close", (event) => {
    if (!shouldHideWindowOnClose() || applicationIsQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  if (restoredWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  setupDarwinCompositorWatchdog(mainWindow);
  setupWindowResizeEvents(mainWindow);
  if (windowStateStore) {
    setupWindowStatePersistence(mainWindow, windowStateStore);
  }
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isNeolixBrowserWebviewAttach(params)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    // The sandboxed keyboard preload must run in every frame so focused iframes keep
    // the same page-first shortcut boundary. Node integration remains disabled.
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.webviewTag = false;
    webPreferences.allowRunningInsecureContent = false;
    delete webPreferences.preload;
    delete params.preload;
    delete (webPreferences as { preloadURL?: string }).preloadURL;
    delete (params as { preloadURL?: string }).preloadURL;
    webPreferences.preload = getBrowserKeyboardPreloadPath();
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    prepareNeolixBrowserWebContents(contents);
    contents.once("destroyed", () => {
      pendingBrowserWindowOpenRequests.delete(contents.id);
    });
    installBrowserWindowOpenHandler({
      contents,
      sourceContents: contents,
      mainWindow,
    });
    contents.on("context-menu", (_contextMenuEvent, params) => {
      showBrowserWebviewContextMenu(mainWindow, contents, params);
    });
    registerBrowserWebviewNavigationGuards(contents);
  });

  showWindowWhenReady(mainWindow, {
    showOnLoad: process.platform === "linux",
  });

  await loadShellContent(mainWindow, options.initialRoute ?? "/");
  return mainWindow;
}

function ownedDesktopWindow(win: BrowserWindow): OwnedDesktopWindow<AgentDeepLinkTarget> {
  return {
    webContentsId: win.webContents.id,
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    isMinimized: () => win.isMinimized(),
    restore: () => win.restore(),
    show: () => win.show(),
    focus: () => win.focus(),
    sendAgent: (target) => win.webContents.send("neolix:event:open-agent", target),
  };
}

traceStartup("main: creating window owner");
desktopWindowOwner = createDesktopWindowOwner<AgentDeepLinkTarget>({
  async create(input) {
    const win = await createWindow({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: input.onCreated,
      onClosed: input.onClosed,
    });
    return ownedDesktopWindow(win);
  },
  windows: () => BrowserWindow.getAllWindows().map(ownedDesktopWindow),
  focusedWindow: () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    return ownedDesktopWindow(win);
  },
  agentRoute: buildAgentDeepLinkRoute,
  deliverAgent: (webContentsId, target) =>
    agentNavigationInbox.deliverOrQueue(webContentsId, target),
});

// ---------------------------------------------------------------------------
// Tray and autostart (myna internal/gui/traymenu.go, internal/autostart)
// ---------------------------------------------------------------------------

function createAutostartHost(): AutostartHost {
  return {
    platform: process.platform,
    // An AppImage runs from a folder mounted anew each time; the file itself
    // is what a login entry must point at (autostart.go self()).
    execPath: process.env.APPIMAGE?.trim() || app.getPath("exe"),
    env: process.env,
    fs: nodeFs,
    getLoginItemSettings: () => app.getLoginItemSettings(),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  };
}

/** The system's record, which is the truth for "Open at login" (autostart.go:41). */
async function readAutostartState(): Promise<AutostartState> {
  try {
    return await getAutostartState(createAutostartHost());
  } catch (error) {
    log.error("[autostart] failed to read the system's record", error);
    return "off";
  }
}

/** Points an existing login record at this executable after it moved (autostart.go:53). */
async function repointAutostart(): Promise<void> {
  try {
    await refreshAutostart(createAutostartHost());
  } catch (error) {
    log.error("[autostart] failed to refresh the login record", error);
  }
}

/** myna's UpdateEveries, the intervals `neolix update auto` accepts. */
const UPDATE_EVERY_MINUTES: Record<string, number> = {
  "30m": 30,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
};

function updateEveryLabel(minutes: number): string {
  for (const [label, value] of Object.entries(UPDATE_EVERY_MINUTES)) {
    if (value === minutes) {
      return label;
    }
  }
  return `${minutes}m`;
}

function autostartReply(state: AutostartState): CliControlReply {
  if (state === "allow") {
    return {
      ok: true,
      message:
        "Neox is set to open at login, but it is switched off in System Settings › General › Login Items: switch it on there",
    };
  }
  if (state === "on") {
    return { ok: true, message: "Neox opens at login, in the tray" };
  }
  return { ok: true, message: "Neox doesn't open at login" };
}

function updateAutoReply(settings: {
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  updateCheckMinutes: number;
}): CliControlReply {
  const every = updateEveryLabel(settings.updateCheckMinutes);
  if (!settings.autoCheckUpdates) {
    return {
      ok: true,
      message: `automatic updates are off · neox update or Settings' Check looks for one (every ${every} when on)`,
    };
  }
  if (!settings.autoDownloadUpdates) {
    return {
      ok: true,
      message: `automatic updates are on · Neox checks every ${every} and only says a version is out; neox update downloads it`,
    };
  }
  return {
    ok: true,
    message: `automatic updates are on · Neox checks every ${every} and downloads it`,
  };
}

async function runAutostartControl(value: "on" | "off" | "status"): Promise<CliControlReply> {
  if (value === "status") {
    return autostartReply(await readAutostartState());
  }
  const enabled = value === "on";
  await setAutostart(createAutostartHost(), enabled);
  // The settings page mirrors the system record; keep the saved copy in step
  // so a restart does not write the old value back (autostart.go:41).
  await getDesktopSettingsStore().patch({ launchAtLogin: enabled });
  return autostartReply(await readAutostartState());
}

function mirrorReply(prefix: string): CliControlReply {
  return {
    ok: true,
    message: prefix
      ? `updates are downloaded through ${prefix}`
      : "updates are downloaded from GitHub",
  };
}

async function runMirrorControl(prefix: string | null): Promise<CliControlReply> {
  const store = getDesktopSettingsStore();
  if (prefix === null) {
    const settings = await store.get();
    return mirrorReply(settings.updateMirror);
  }
  const trimmed = prefix.trim();
  const updateMirror = trimmed === "off" || trimmed === "none" ? "" : trimmed;
  await store.patch({ updateMirror });
  return mirrorReply(updateMirror);
}

async function runChannelControl(channel: "stable" | "beta" | null): Promise<CliControlReply> {
  const store = getDesktopSettingsStore();
  if (channel === null) {
    const settings = await store.get();
    return { ok: true, message: `update channel: ${settings.releaseChannel}` };
  }
  await store.patch({ releaseChannel: channel });
  return { ok: true, message: `update channel: ${channel}` };
}

interface AutoSettings {
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  updateCheckMinutes: number;
}

function applyAutoTokens(
  settings: AutoSettings,
  tokens: readonly string[],
): { ok: true; settings: AutoSettings } | { ok: false; message: string } {
  const next = { ...settings };
  for (const token of tokens) {
    if (token === "on") {
      next.autoCheckUpdates = true;
    } else if (token === "off") {
      next.autoCheckUpdates = false;
    } else if (token === "download") {
      next.autoDownloadUpdates = true;
    } else if (token === "notify") {
      next.autoDownloadUpdates = false;
    } else {
      const minutes = UPDATE_EVERY_MINUTES[token];
      if (minutes === undefined) {
        return {
          ok: false,
          message: `update auto takes on, off, download, notify or how often (30m, 1h, 6h or 24h), not "${token}"`,
        };
      }
      next.updateCheckMinutes = minutes;
    }
  }
  return { ok: true, settings: next };
}

async function runAutoControl(tokens: readonly string[]): Promise<CliControlReply> {
  const store = getDesktopSettingsStore();
  const settings = await store.get();
  if (tokens.length === 0) {
    return updateAutoReply(settings);
  }
  const applied = applyAutoTokens(settings, tokens);
  if (!applied.ok) {
    return { ok: false, message: applied.message };
  }
  return updateAutoReply(await store.patch(applied.settings));
}

async function runUpdateCheck(
  releaseChannel: "stable" | "beta",
  action: { proxy?: string; mirror?: string },
): Promise<CliControlReply> {
  if (action.proxy !== undefined) {
    // myna takes --proxy for this check only (update.go proxied()).
    await applyUpdateProxy((config) => session.defaultSession.setProxy(config), {
      ...process.env,
      HTTPS_PROXY: action.proxy,
    });
  }
  const result = await checkForAppUpdate({
    currentVersion: app.getVersion(),
    releaseChannel,
    intent: "manual",
    autoDownload: false,
    ...(action.mirror === undefined ? {} : { mirror: action.mirror }),
  });
  if (result.errorMessage !== null && !result.hasUpdate) {
    return { ok: false, message: result.errorMessage };
  }
  return {
    ok: true,
    message: result.hasUpdate
      ? `Neox ${result.latestVersion} is out (you have ${app.getVersion()})`
      : `Neox ${app.getVersion()} is up to date`,
  };
}

async function runUpdateInstall(releaseChannel: "stable" | "beta"): Promise<CliControlReply> {
  const result = await downloadAndInstallUpdate(
    { currentVersion: app.getVersion(), releaseChannel },
    async () => {
      await stopDesktopDaemon("app_update");
    },
  );
  return {
    ok: result.installed,
    message: result.installed
      ? `updated Neox to ${result.version ?? app.getVersion()}`
      : result.message,
    ...(result.installed ? { keepRunning: true } : {}),
  };
}

async function runUpdateControl(action: {
  check: boolean;
  proxy?: string;
  mirror?: string;
}): Promise<CliControlReply> {
  const settings = await getDesktopSettingsStore().get();
  return action.check
    ? runUpdateCheck(settings.releaseChannel, action)
    : runUpdateInstall(settings.releaseChannel);
}

/**
 * Runs one command the CLI handed over (myna runs `tray|panel|autostart|update`
 * in its own binary; the Neox CLI launches this app instead). The answer goes
 * back through the reply file, which is how a detached launch still prints.
 */
async function runCliControl(request: CliControlRequest): Promise<CliControlReply> {
  try {
    switch (request.action.kind) {
      case "autostart":
        return await runAutostartControl(request.action.value);
      case "update-mirror":
        return await runMirrorControl(request.action.prefix);
      case "update-channel":
        return await runChannelControl(request.action.channel);
      case "update-auto":
        return await runAutoControl(request.action.tokens);
      case "update":
        return await runUpdateControl(request.action);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The login launch shows the tray only, no window (autostart.go Arg). */
function startHidden(): boolean {
  return launchedHidden({
    platform: process.platform,
    argv: process.argv,
    loginItem: app.getLoginItemSettings(),
  });
}

// ---------------------------------------------------------------------------
// Quick panel (myna app.go togglePanel; gui/panelkey.go)
// ---------------------------------------------------------------------------

const QUICK_PANEL_WIDTH = 380;
const QUICK_PANEL_HEIGHT = 520;
const QUICK_PANEL_GAP = 6;
const QUICK_PANEL_TITLE = "Neox Panel";

let quickPanelWindow: BrowserWindow | null = null;
let stopWatchingPanelClicks: (() => void) | null = null;

/** Runs hyprctl and returns its output; errors reach the caller. */
function runHyprctl(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("hyprctl", [...args], { timeout: 2_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function stopPanelClickWatch(): void {
  stopWatchingPanelClicks?.();
  stopWatchingPanelClicks = null;
  void stopReportingClicks(runHyprctl);
}

/**
 * Omarchy's Hyprland places the panel itself: its window rule pins the panel
 * to the monitor under the click, and a non-consuming mouse bind closes it
 * on a click outside (focus follows the mouse there).
 */
async function showQuickPanelOnHyprland(win: BrowserWindow): Promise<void> {
  const placement = await currentPanelPlacement(QUICK_PANEL_WIDTH, runHyprctl).catch(() => null);
  if (placement) {
    await placePanelWindow(runHyprctl, QUICK_PANEL_TITLE, placement);
  }
  win.show();
  win.focus();
  await reportClicks(runHyprctl);
  stopPanelClickWatch();
  stopWatchingPanelClicks = watchClicks(process.env, () => {
    void clickedOutside(runHyprctl, QUICK_PANEL_TITLE)
      .then((outside) => {
        if (outside) {
          hideQuickPanel();
        }
        return undefined;
      })
      .catch(() => undefined);
  });
}

function ensureQuickPanelWindow(): BrowserWindow {
  if (quickPanelWindow && !quickPanelWindow.isDestroyed()) {
    return quickPanelWindow;
  }
  const win = new BrowserWindow({
    title: QUICK_PANEL_TITLE,
    width: QUICK_PANEL_WIDTH,
    height: QUICK_PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    backgroundColor: getWindowBackgroundColor(resolveSystemWindowTheme()),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  installStartupRecoveryNavigation(win);
  win.on("blur", () => {
    // Omarchy has focus follow the mouse, so the pointer merely passing over
    // another window would close the panel; its click watcher closes it.
    if (!isHyprland(process.env, process.platform)) {
      win.hide();
    }
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("hide", () => {
    stopPanelClickWatch();
    // A hidden panel must not keep the app alive after the last main window
    // closes on Windows and Linux.
    if (
      process.platform !== "darwin" &&
      BrowserWindow.getAllWindows().every((window) => window === win || !window.isVisible())
    ) {
      win.destroy();
    }
  });
  win.on("closed", () => {
    shellWindowRoutes.delete(win.webContents.id);
    if (quickPanelWindow === win) {
      quickPanelWindow = null;
    }
  });
  // The Electron shell uses TanStack's hash history, so the route lives in the
  // fragment; `/panel` alone would resolve to the app's root route.
  void loadShellContent(win, "/panel").catch((error) =>
    log.error("[panel] failed to load the quick panel", error),
  );
  quickPanelWindow = win;
  return win;
}

/** Under the tray icon the click came from, or by the pointer for the shortcut. */
function placeQuickPanel(win: BrowserWindow, anchor: Electron.Rectangle | null): void {
  const point = anchor
    ? { x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }
    : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;

  let x: number;
  let y: number;
  if (anchor) {
    x = point.x - Math.round(QUICK_PANEL_WIDTH / 2);
    const below = anchor.y + anchor.height + QUICK_PANEL_GAP;
    const above = anchor.y - QUICK_PANEL_HEIGHT - QUICK_PANEL_GAP;
    y = below + QUICK_PANEL_HEIGHT <= area.y + area.height ? below : above;
  } else {
    x = point.x - Math.round(QUICK_PANEL_WIDTH / 2);
    y = point.y + QUICK_PANEL_GAP * 2;
  }

  const maxX = area.x + area.width - QUICK_PANEL_WIDTH - QUICK_PANEL_GAP;
  const maxY = area.y + area.height - QUICK_PANEL_HEIGHT - QUICK_PANEL_GAP;
  win.setBounds({
    x: Math.round(Math.min(Math.max(x, area.x + QUICK_PANEL_GAP), maxX)),
    y: Math.round(Math.min(Math.max(y, area.y + QUICK_PANEL_GAP), maxY)),
    width: QUICK_PANEL_WIDTH,
    height: QUICK_PANEL_HEIGHT,
  });
}

/** Opens the panel by the tray icon, or closes it if it is open. */
function toggleQuickPanel(anchor: Electron.Rectangle | null): void {
  const win = ensureQuickPanelWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  if (isHyprland(process.env, process.platform)) {
    void showQuickPanelOnHyprland(win);
    return;
  }
  placeQuickPanel(win, anchor);
  win.show();
  win.focus();
}

function hideQuickPanel(): void {
  if (quickPanelWindow && !quickPanelWindow.isDestroyed()) {
    quickPanelWindow.hide();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function receiveAgentDeepLink(input: string): void {
  const target = parseAgentDeepLink(input);
  if (!target) {
    return;
  }

  if (bootstrapIsComplete) {
    void desktopWindowOwner
      .openOrFocusAgent(target)
      .catch((error) => log.error("[window] failed to route agent link", error));
    return;
  }

  pendingAgentNavigation = target;
  void bootstrapComplete.then(() => {
    if (pendingAgentNavigation !== target) {
      return undefined;
    }
    pendingAgentNavigation = null;
    void desktopWindowOwner
      .openOrFocusAgent(target)
      .catch((error) => log.error("[window] failed to route queued agent link", error));
    return undefined;
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAgentDeepLink(url);
});

/** Set before the quit lifecycle closes windows: then a close really closes. */
let applicationIsQuitting = false;
app.on("before-quit", () => {
  applicationIsQuitting = true;
});

function setupSingleInstanceLock(): boolean {
  if (DISABLE_SINGLE_INSTANCE_LOCK) {
    log.info("[single-instance] disabled by NEOLIX_DISABLE_SINGLE_INSTANCE_LOCK");
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", (_event, commandLine) => {
    // A CLI control command never opens a window; it answers its reply file.
    const control = parseCliControlRequest(commandLine);
    if (control !== null) {
      void bootstrapComplete
        .then(async () => {
          await writeCliControlReply(control.replyPath, await runCliControl(control));
          return true;
        })
        .catch((error) => log.error("[cli-control] failed to answer the CLI", error));
      return;
    }
    // `neolix panel` toggles the quick panel, as myna's second instance does.
    if (hasPanelArg(commandLine)) {
      void bootstrapComplete
        .then(() => toggleQuickPanel(null))
        .catch((error) => log.error("[panel] failed to open from the CLI", error));
      return;
    }
    // `neolix tray` on a running app has nothing to show (myna ignores it).
    if (commandLine.includes(HIDDEN_ARG)) {
      return;
    }

    const agentTarget = parseAgentDeepLinkFromArgv(commandLine);
    if (agentTarget) {
      void bootstrapComplete
        .then(() => desktopWindowOwner.openOrFocusAgent(agentTarget))
        .catch((error) => log.error("[window] failed to route second-instance agent link", error));
      return;
    }

    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);
    // Relaunching the app (CLI `neolix [path]`, double-click, etc.) opens a new
    // window rather than focusing the existing one. Wait for bootstrap (not just
    // app.whenReady) so the protocol + IPC handlers exist before the window loads.
    void bootstrapComplete
      .then(() => desktopWindowOwner.openAdditional({ pendingProjectPath: openProjectPath }))
      .catch((error) => {
        log.error("[window] failed to create window from second-instance", error);
      });
  });

  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parsePassthroughCliArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = await runPassthroughCli(cliArgs);
    app.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  }

  return true;
}

async function bootstrap(): Promise<void> {
  traceStartup("bootstrap: single-instance lock");
  if (!setupSingleInstanceLock()) {
    traceStartup("bootstrap: another instance holds the lock; quitting");
    return;
  }

  traceStartup("bootstrap: waiting for app ready");
  await app.whenReady();
  traceStartup("bootstrap: app ready");

  // `neolix autostart|update …` hands its work to this process (myna's CLI
  // runs in the app's own binary). The answer goes through the reply file,
  // and no window or tray is built for a command that only changes settings.
  const cliControl = parseCliControlRequest(process.argv);
  if (cliControl !== null) {
    const reply = await runCliControl(cliControl);
    await writeCliControlReply(cliControl.replyPath, reply);
    if (reply.keepRunning !== true) {
      app.exit(reply.ok ? 0 : 1);
    }
    // The updater owns the quit when it is installing; either way this launch
    // has done its one command and builds no window or tray.
    return;
  }

  // The system's login record is the truth; a mismatch means the user
  // changed it outside Neox, so the saved setting follows it (autostart.go:41).
  try {
    const store = getDesktopSettingsStore();
    const state = await readAutostartState();
    const settings = await store.get();
    const systemOn = state !== "off";
    await repointAutostart();
    if (systemOn !== settings.launchAtLogin) {
      await store.patch({ launchAtLogin: systemOn });
    }
  } catch (error) {
    log.error("[autostart] failed to reconcile the login record", error);
  }

  let desktopWebStartup: Promise<void> | null = null;
  try {
    const settings = await getDesktopSettingsStore().get();
    applySystemPreferences(settings);
    applyTraySettings(settings);
    traceStartup("bootstrap: starting desktop web renderer");
    // Do not wait for the probe: the first window shows its waiting page now and
    // reloads when the daemon answers.
    desktopWebStartup = startDesktopWebRenderer();
  } catch (error) {
    log.error("[desktop settings] failed to apply system preferences", error);
    // Without a probe the waiting page would never resolve; show the error page.
    failDesktopWebStartup(error instanceof Error ? error.message : String(error));
  }

  if (isHyprland(process.env, process.platform)) {
    // A previous run that crashed left its non-consuming click bind in
    // Hyprland; remove it before this run reports clicks of its own.
    void clearPanelClicks(runHyprctl);
  }

  await applyAppIcon();
  // The About panel otherwise reads the host bundle's Info.plist: in a dev checkout that is the
  // stock Electron.app ("Electron 44.x"). Name and version come from this app instead; the icon
  // follows the Dock icon on macOS and needs an explicit path elsewhere.
  const aboutIconPath = await getCurrentAppIconPath();
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    ...(aboutIconPath && process.platform !== "darwin" ? { iconPath: aboutIconPath } : {}),
  });
  setupApplicationMenu({
    onNewWindow: () => {
      void desktopWindowOwner.openAdditional().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  registerDaemonManager();
  registerWindowManager({ mode: DESKTOP_WINDOW_CHROME_MODE });
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOsPermissionsIpc();
  registerDesktopWebIpc({
    stopDaemon: async () => {
      await stopDesktopDaemon("app_update");
    },
    setAppIcon: setAppIconChoice,
  });
  registerDesktopWebBrowserGuestIpc();
  const openExternalUrl = createExternalUrlOpener({ open: shell.openExternal });
  const openAgentLink = createAgentLinkOpener({ open: shell.openExternal });
  ipcMain.handle("neolix:opener:openUrl", (_event, value: unknown) => openExternalUrl(value));
  ipcMain.handle("neolix:opener:openAgentLink", (_event, value: unknown) => openAgentLink(value));
  registerEditorTargetHandlers();
  registerBrowserAutomationIpc();

  // In-app "Open in new window": opens a window that lands on the given project
  // via the same open-project flow as a CLI launch (no move, no ownership).
  // The quick panel is a separate renderer: clicking a row opens that agent in
  // the main window, which the panel cannot reach through its own router.
  ipcMain.handle("neolix:panel:hide", () => hideQuickPanel());
  ipcMain.handle("neolix:panel:openMain", () => {
    hideQuickPanel();
    void desktopWindowOwner.restoreWhenActivated().catch((error) => {
      log.error("[panel] failed to open the main window", error);
    });
  });
  ipcMain.handle("neolix:panel:openAgent", (_event, value: unknown) => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as { serverId?: unknown; agentId?: unknown };
    if (typeof record.serverId !== "string" || typeof record.agentId !== "string") {
      return;
    }
    const target: AgentDeepLinkTarget = {
      serverId: record.serverId.trim(),
      agentId: record.agentId.trim(),
    };
    if (target.serverId === "" || target.agentId === "") {
      return;
    }
    hideQuickPanel();
    void desktopWindowOwner.openOrFocusAgent(target).catch((error) => {
      log.error("[panel] failed to open the selected agent", error);
    });
  });

  // The forked web UI has no serverId deep link; the panel asks the main window
  // to navigate to the thread id instead.
  ipcMain.handle("neolix:panel:openThread", (event, value: unknown) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    hideQuickPanel();
    const threadId = value.trim();
    const target = BrowserWindow.getAllWindows().find(
      (win) => win.webContents.id !== event.sender.id && !win.isDestroyed(),
    );
    if (!target) {
      // `neolix panel` cold-starts with the panel as the only window; a row click
      // must still open the thread, as the old UI's panel.openAgent did.
      void desktopWindowOwner
        .openPrimary({ initialRoute: `/${encodeURIComponent(threadId)}` })
        .catch((error) => log.error("[panel] failed to open the selected thread", error));
      return;
    }
    if (target.isMinimized()) {
      target.restore();
    }
    target.show();
    target.focus();
    target.webContents.send("neolix:event:open-thread", { threadId });
  });

  ipcMain.handle("neolix:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await desktopWindowOwner.openAdditional({
      pendingProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  // The tray exists before any window so a login launch can stay in it.
  installDesktopTray({
    onShowWindow: () => {
      void desktopWindowOwner.restoreWhenActivated().catch((error) => {
        log.error("[tray] failed to show a window", error);
      });
    },
    onTogglePanel: (anchor) => toggleQuickPanel(anchor),
  });

  // A login launch has no renderer to read the allowances, so the main
  // process polls the daemon itself (myna's watchTrayUsage lives in the app
  // process). tray-manager keeps a live renderer's reading ahead of this one.
  const trayUsagePoller = startTrayUsagePolling({
    readSettings: () => getDesktopSettingsStore().get(),
    resolveTarget: resolveTrayUsageTarget,
    createClient: createDaemonTrayUsageClient,
    publish: (state) => setTrayUsage(state, "main"),
    getLanguage: currentTrayLanguage,
  });
  setTrayUsageRefresher(() => trayUsagePoller.refresh());
  if (startHidden()) {
    // Nothing else starts a managed daemon without a renderer; the figures
    // would never arrive.
    void startDesktopDaemonFromTray().catch((error) => {
      log.error("[tray] failed to start the managed daemon", error);
    });
  }

  // The first window of the session restores and persists saved geometry. A
  // login launch opens no window (autostart.go Arg); `neolix panel` opens the
  // quick panel alone.
  const initialAgentNavigation = pendingAgentNavigation;
  pendingAgentNavigation = null;
  if (hasPanelArg(process.argv)) {
    toggleQuickPanel(null);
  } else if (!startHidden() || initialAgentNavigation !== null || pendingOpenProjectPath !== null) {
    await desktopWindowOwner.openPrimary({
      initialRoute: initialAgentNavigation ? buildAgentDeepLinkRoute(initialAgentNavigation) : null,
      pendingProjectPath: pendingOpenProjectPath,
    });
  }
  pendingOpenProjectPath = null;

  if (desktopWebStartup) {
    void desktopWebStartup.then(
      () => {
        traceStartup("bootstrap: desktop web renderer settled");
        return reloadShellWindows();
      },
      (error: unknown) => {
        log.error("[desktop-web] startup probe failed", error);
        failDesktopWebStartup(error instanceof Error ? error.message : String(error));
        return reloadShellWindows();
      },
    );
  }
  // Protocol + IPC handlers and the first window now exist: release any
  // second-instance launches that arrived during cold start.
  bootstrapIsComplete = true;
  resolveBootstrapComplete();

  if (pendingAgentNavigation) {
    const target = pendingAgentNavigation;
    pendingAgentNavigation = null;
    await desktopWindowOwner.openOrFocusAgent(target);
  }

  app.on("activate", () => {
    void desktopWindowOwner.restoreWhenActivated().catch((error) => {
      console.error("Failed to restore a desktop window after activation", error);
    });
  });
}

traceStartup("main: running desktop startup");
void runDesktopStartup({
  hasPendingGuiLaunchRequest: Boolean(pendingOpenProjectPath || pendingAgentNavigation),
  runCliPassthroughIfRequested,
  inheritLoginShellEnv,
  bootstrapGui: bootstrap,
}).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function showDaemonShutdownDialog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("neolix:event:quitting", {});
  }
}

async function confirmQuitIfEnabled(): Promise<boolean> {
  const settings = await getDesktopSettingsStore().get();
  if (!settings.confirmQuit) {
    return true;
  }
  // The desktop-web UI answers with a list of running chats; a window that
  // predates that protocol (or never loaded) times out to the native dialog.
  const answer = await quitConfirmationBroker.ask();
  if (answer !== null) {
    return answer;
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Quit Neox?",
    detail: "Running agents stop when Neox quits.",
  });
  return response === 0;
}

const quitLifecycle = createQuitLifecycle({
  app,
  closeTransportSessions: closeAllTransportSessions,
  confirmQuit: confirmQuitIfEnabled,
  stopDesktopManagedDaemonIfNeeded: () =>
    stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: getDesktopSettingsStore(),
      isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
      stopDaemon: () => stopDesktopDaemonViaCli("quit"),
      showShutdownFeedback: showDaemonShutdownDialog,
    }),
  installAppUpdateOnQuit: async (signal) => {
    const settings = await getDesktopSettingsStore().get();
    return installAppUpdateOnQuit({
      currentVersion: app.getVersion(),
      releaseChannel: settings.releaseChannel,
      signal,
    });
  },
  createUpdateDeadlineSignal: () => AbortSignal.timeout(UPDATE_QUIT_DEADLINE_MS),
  onStopError: (error) => {
    log.error("[desktop daemon] failed to stop managed daemon on quit", error);
  },
  onUpdateError: (error) => {
    log.error("[auto-updater] failed to validate downloaded update on quit", error);
  },
});

// electron-updater forwards this event through Electron's built-in autoUpdater.
electronAutoUpdater.on("before-quit-for-update", () => {
  log.info("[auto-updater] before-quit-for-update", { currentVersion: app.getVersion() });
  quitLifecycle.handleBeforeQuitForUpdate();
});
app.on("before-quit", quitLifecycle.handleBeforeQuit);
registerExternalQuitSignals({ signals: process, quit: () => app.quit() });

app.on("window-all-closed", () => {
  // With a tray the app stays in it, as myna does; without one (a failed
  // tray creation) the old rule stands.
  if (process.platform !== "darwin" && !isDesktopTrayInstalled()) {
    app.quit();
  }
});
