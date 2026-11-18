import { writeFile } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  shell,
  ClipboardItem,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import log from "electron-log/main";

import { DESKTOP_APP_ICON_NAMES, type DesktopAppIconName } from "../settings/desktop-settings.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  downloadAppUpdate,
  releasePageUrl,
  type AppReleaseChannel,
} from "./auto-updater.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";

type DesktopRuntimeArch = "arm64" | "x64" | "other";
type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";
type DesktopTheme = "light" | "dark" | "system";

interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
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
  /** The update can only be downloaded from releaseUrl (unsigned macOS build). */
  manualInstall: boolean;
}

interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

interface DesktopKeepAwakeState {
  enabled: boolean;
  active: boolean;
  onBattery: boolean;
}

interface DesktopContextMenuItem {
  id: string;
  label: string;
  separatorBefore?: boolean;
  destructive?: boolean;
  iconDataUrl?: string;
  children?: readonly DesktopContextMenuItem[];
}

interface SaveFileInput {
  defaultFilename: string;
  contents: string;
  filters?: ReadonlyArray<{ name: string; extensions: ReadonlyArray<string> }>;
}

function runtimeArch(value: string): DesktopRuntimeArch {
  return value === "arm64" || value === "x64" ? value : "other";
}

function createUpdateState(): DesktopUpdateState {
  return {
    enabled: app.isPackaged,
    status: app.isPackaged ? "idle" : "disabled",
    currentVersion: app.getVersion(),
    hostArch: runtimeArch(process.arch),
    appArch: runtimeArch(process.arch),
    runningUnderARM64Translation: isRunningUnderARM64Translation(),
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    installFailureCount: 0,
    flavor: "production",
    releaseUrl: null,
    manualInstall: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPath(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function buildContextMenuTemplate(
  items: readonly DesktopContextMenuItem[],
  resolve: (id: string) => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string" || typeof item.label !== "string") {
      continue;
    }
    if (item.separatorBefore) {
      template.push({ type: "separator" });
    }
    const icon =
      typeof item.iconDataUrl === "string" && item.iconDataUrl.startsWith("data:image/")
        ? nativeImage.createFromDataURL(item.iconDataUrl)
        : null;
    if (Array.isArray(item.children) && item.children.length > 0) {
      template.push({
        label: item.label,
        submenu: buildContextMenuTemplate(item.children, resolve),
      });
      continue;
    }
    template.push({
      label: item.label,
      ...(icon && !icon.isEmpty() ? { icon } : {}),
      click: () => resolve(item.id),
    });
  }
  return template;
}

export interface DesktopWebIpcOptions {
  /** Stops the desktop-managed daemon before an update installs. */
  readonly stopDaemon: () => Promise<void>;
  /** Saves and shows an Appearance › App icon choice. */
  readonly setAppIcon: (icon: DesktopAppIconName) => Promise<void>;
}

/**
 * IPC surface for the forked web renderer's `window.desktopBridge`. It only
 * wraps capabilities this desktop already owns; Synara-only services (accounts,
 * AppSnap, audio analysis, computer use) are intentionally absent so the web
 * app keeps its browser fallbacks.
 */
export function registerDesktopWebIpc(options: DesktopWebIpcOptions): void {
  // -------------------------------------------------------------------------
  // Updates: read state and run a user-initiated check. Download and install
  // use the same electron-updater flow the existing UI uses.
  // -------------------------------------------------------------------------
  let updateState = createUpdateState();
  let updateCheckInFlight: Promise<DesktopUpdateState> | null = null;

  const publishUpdateState = (next: DesktopUpdateState): DesktopUpdateState => {
    updateState = next;
    broadcast("neolix:event:update-state", next);
    return next;
  };

  const releaseChannel = async (): Promise<AppReleaseChannel> =>
    (await getDesktopSettingsStore().get()).releaseChannel;
  // The mirror is a shell setting, so the renderer's check/download/install all
  // read it here instead of carrying it over IPC.
  const updateMirror = async (): Promise<string> =>
    (await getDesktopSettingsStore().get()).updateMirror;

  const checkForUpdates = async (): Promise<DesktopUpdateState> => {
    if (!app.isPackaged) {
      return publishUpdateState({ ...updateState, status: "disabled", enabled: false });
    }
    updateCheckInFlight ??= (async () => {
      publishUpdateState({ ...updateState, status: "checking", enabled: true, message: null });
      try {
        const channel = await releaseChannel();
        const result = await checkForAppUpdate({
          currentVersion: app.getVersion(),
          releaseChannel: channel,
          intent: "manual",
          autoDownload: false,
          mirror: await updateMirror(),
        });
        if (result.errorMessage !== null && !result.hasUpdate) {
          return publishUpdateState({
            ...updateState,
            status: "error",
            enabled: true,
            errorContext: "check",
            canRetry: true,
            message: result.errorMessage,
            checkedAt: new Date().toISOString(),
          });
        }
        let status: DesktopUpdateStatus = "up-to-date";
        if (result.readyToInstall) {
          status = "downloaded";
        } else if (result.hasUpdate) {
          status = "available";
        }
        return publishUpdateState({
          ...updateState,
          status,
          enabled: true,
          availableVersion: result.hasUpdate ? result.latestVersion : null,
          downloadedVersion: result.readyToInstall ? result.latestVersion : null,
          releaseUrl: result.hasUpdate ? releasePageUrl(result.latestVersion) : null,
          manualInstall: result.manualInstall === true,
          errorContext: null,
          canRetry: false,
          message: null,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        return publishUpdateState({
          ...updateState,
          status: "error",
          enabled: true,
          errorContext: "check",
          canRetry: true,
          message: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        });
      } finally {
        updateCheckInFlight = null;
      }
    })();
    return updateCheckInFlight;
  };

  const downloadUpdate = async (): Promise<DesktopUpdateActionResult> => {
    // A manual-install build has nothing to download; the renderer opens releaseUrl.
    if (!app.isPackaged || updateState.manualInstall) {
      return { accepted: false, completed: true, state: updateState };
    }
    publishUpdateState({
      ...updateState,
      status: "downloading",
      errorContext: null,
      message: null,
      canRetry: false,
    });
    try {
      const result = await downloadAppUpdate({
        currentVersion: app.getVersion(),
        releaseChannel: await releaseChannel(),
        mirror: await updateMirror(),
      });
      if (result.downloaded) {
        return {
          accepted: true,
          completed: true,
          state: publishUpdateState({
            ...updateState,
            status: "downloaded",
            availableVersion: result.version ?? updateState.availableVersion,
            downloadedVersion: result.version ?? updateState.availableVersion,
            errorContext: null,
            message: null,
          }),
        };
      }
      const upToDate = result.message === "Up to date.";
      return {
        accepted: true,
        completed: true,
        state: publishUpdateState({
          ...updateState,
          status: upToDate ? "up-to-date" : "error",
          errorContext: upToDate ? null : "download",
          canRetry: !upToDate,
          message: upToDate ? null : result.message,
        }),
      };
    } catch (error) {
      return {
        accepted: true,
        completed: true,
        state: publishUpdateState({
          ...updateState,
          status: "error",
          errorContext: "download",
          canRetry: true,
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  };

  const installUpdate = async (): Promise<DesktopUpdateActionResult> => {
    if (!app.isPackaged || updateState.manualInstall) {
      return { accepted: false, completed: true, state: updateState };
    }
    publishUpdateState({
      ...updateState,
      status: "downloading",
      errorContext: null,
      message: null,
    });
    try {
      const result = await downloadAndInstallUpdate(
        {
          currentVersion: app.getVersion(),
          releaseChannel: await releaseChannel(),
          mirror: await updateMirror(),
        },
        options.stopDaemon,
      );
      return {
        accepted: true,
        completed: result.installed,
        state: publishUpdateState({
          ...updateState,
          status: result.installed ? "downloaded" : "error",
          errorContext: result.installed ? null : "install",
          canRetry: !result.installed,
          installFailureCount: result.installed
            ? updateState.installFailureCount
            : updateState.installFailureCount + 1,
          downloadedVersion: result.version ?? updateState.downloadedVersion,
          message: result.installed ? null : result.message,
        }),
      };
    } catch (error) {
      return {
        accepted: true,
        completed: false,
        state: publishUpdateState({
          ...updateState,
          status: "error",
          errorContext: "install",
          canRetry: true,
          installFailureCount: updateState.installFailureCount + 1,
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  };

  ipcMain.handle("neolix:desktop:update-state", () => updateState);
  ipcMain.handle("neolix:desktop:check-updates", () => checkForUpdates());
  ipcMain.handle("neolix:desktop:download-update", () => downloadUpdate());
  ipcMain.handle("neolix:desktop:install-update", () => installUpdate());

  // -------------------------------------------------------------------------
  // Keep awake: the web renderer's own preference, separate from myna's
  // agent-aware preventSleep controller.
  // -------------------------------------------------------------------------
  let keepAwakeEnabled = false;
  // The new desktop UI has no remote-access switch of its own; treat this
  // computer as allowed until the account panel reports otherwise.
  let remoteAccessAllowed = true;
  let keepAwakeBlockerId: number | null = null;

  const keepAwakeState = (): DesktopKeepAwakeState => {
    const onBattery = powerMonitor.isOnBatteryPower();
    const active = keepAwakeEnabled && remoteAccessAllowed && !onBattery;
    setKeepAwakeBlocker(active);
    return { enabled: keepAwakeEnabled, active, onBattery };
  };

  const setKeepAwakeBlocker = (active: boolean): void => {
    if (active) {
      if (keepAwakeBlockerId === null || !powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
        keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      }
      return;
    }
    if (keepAwakeBlockerId !== null) {
      if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
        powerSaveBlocker.stop(keepAwakeBlockerId);
      }
      keepAwakeBlockerId = null;
    }
  };

  ipcMain.handle("neolix:desktop:keep-awake-state", () => keepAwakeState());
  ipcMain.handle("neolix:desktop:set-keep-awake-enabled", async (_event, enabled: unknown) => {
    keepAwakeEnabled = enabled === true;
    await getDesktopSettingsStore()
      .patch({ keepAwakeEnabled: keepAwakeEnabled })
      .catch((error) => log.warn("[keep-awake] failed to persist preference", error));
    return keepAwakeState();
  });
  ipcMain.handle("neolix:desktop:set-remote-access-allowed", (_event, allowed: unknown) => {
    remoteAccessAllowed = allowed === true;
    return keepAwakeState();
  });
  powerMonitor.on("on-ac", () => setKeepAwakeBlocker(keepAwakeState().active));
  powerMonitor.on("on-battery", () => setKeepAwakeBlocker(false));

  // -------------------------------------------------------------------------
  // Native dialogs, folder reveal, external links and menus.
  // -------------------------------------------------------------------------
  ipcMain.handle("neolix:desktop:save-file", async (event, rawInput: unknown) => {
    const input = asRecord(rawInput) as Partial<SaveFileInput> | null;
    if (!input || typeof input.contents !== "string") {
      return null;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const filters = Array.isArray(input.filters)
      ? (input.filters as ReadonlyArray<{
          name?: unknown;
          extensions?: unknown;
        }>)
      : [];
    const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      defaultPath: typeof input.defaultFilename === "string" ? input.defaultFilename : undefined,
      filters: filters.map((filter) => ({
        name: String(filter.name ?? ""),
        extensions: Array.isArray(filter.extensions)
          ? filter.extensions.map((extension: unknown) => String(extension))
          : [],
      })),
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await writeFile(result.filePath, input.contents, "utf8");
    return result.filePath;
  });

  ipcMain.handle("neolix:desktop:show-in-folder", (_event, rawPath: unknown) => {
    const target = readPath(rawPath);
    if (target !== null) {
      shell.showItemInFolder(target);
    }
  });

  ipcMain.handle("neolix:desktop:open-external", async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string") {
      return false;
    }
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
      }
      await shell.openExternal(url.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    "neolix:desktop:context-menu",
    (event, rawItems: unknown, rawPosition: unknown): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !Array.isArray(rawItems)) {
        return Promise.resolve(null);
      }
      const position = asRecord(rawPosition);
      return new Promise((resolve) => {
        let settled = false;
        const settle = (id: string | null): void => {
          if (settled) return;
          settled = true;
          resolve(id);
        };
        const menu = Menu.buildFromTemplate(
          buildContextMenuTemplate(rawItems as DesktopContextMenuItem[], settle),
        );
        menu.popup({
          window: win,
          ...(typeof position?.x === "number" ? { x: Math.round(position.x) } : {}),
          ...(typeof position?.y === "number" ? { y: Math.round(position.y) } : {}),
          callback: () => settle(null),
        });
      });
    },
  );

  ipcMain.handle("neolix:desktop:set-theme", (_event, theme: unknown) => {
    if (theme === "light" || theme === "dark" || theme === "system") {
      nativeTheme.themeSource = theme as DesktopTheme;
    }
  });

  // -------------------------------------------------------------------------
  // Clipboard, zoom, icon and app lifecycle helpers.
  // -------------------------------------------------------------------------
  ipcMain.handle("neolix:desktop:write-clipboard-text", (_event, value: unknown) => {
    if (typeof value === "string") {
      clipboard.writeText(value);
      return true;
    }
    return false;
  });

  ipcMain.handle("neolix:desktop:write-clipboard-image", async (_event, rawDataUrl: unknown) => {
    if (typeof rawDataUrl !== "string" || !rawDataUrl.startsWith("data:image/")) {
      return false;
    }
    const image = nativeImage.createFromDataURL(rawDataUrl);
    if (image.isEmpty()) {
      return false;
    }
    const png = image.toPNG();
    const bytes = new Uint8Array(png.byteLength);
    bytes.set(png);
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
    ]);
    return true;
  });

  ipcMain.handle("neolix:window:get-zoom-factor", (event) => event.sender.getZoomFactor());

  const watchedZoomSenders = new Set<number>();
  const watchZoom = (contents: WebContents): void => {
    if (watchedZoomSenders.has(contents.id)) {
      return;
    }
    watchedZoomSenders.add(contents.id);
    contents.on("zoom-changed", () => {
      if (!contents.isDestroyed()) {
        contents.send("neolix:event:zoom-factor", contents.getZoomFactor());
      }
    });
    contents.once("destroyed", () => watchedZoomSenders.delete(contents.id));
  };
  ipcMain.handle("neolix:window:watch-zoom", (event) => {
    watchZoom(event.sender);
    return event.sender.getZoomFactor();
  });

  // The choice lives in desktop-settings.json, so it survives restarts and the renderer's
  // hydrate (useDesktopAppIcon) reads back what was picked, not a per-process default.
  ipcMain.handle(
    "neolix:desktop:get-app-icon",
    async () => (await getDesktopSettingsStore().get()).appIcon,
  );
  ipcMain.handle("neolix:desktop:set-app-icon", async (_event, icon: unknown) => {
    if (!(DESKTOP_APP_ICON_NAMES as readonly unknown[]).includes(icon)) {
      throw new Error(`Unknown app icon: ${String(icon)}`);
    }
    await options.setAppIcon(icon as DesktopAppIconName);
  });

  ipcMain.handle("neolix:desktop:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // -------------------------------------------------------------------------
  // Startup: restore the keep-awake preference and run the background check
  // when the user allowed it.
  // -------------------------------------------------------------------------
  void getDesktopSettingsStore()
    .get()
    .then((settings) => {
      keepAwakeEnabled = settings.keepAwakeEnabled;
      setKeepAwakeBlocker(keepAwakeState().active);
      if (settings.autoCheckUpdates && app.isPackaged) {
        setTimeout(() => {
          void checkForUpdates();
        }, 5_000);
      }
      return undefined;
    })
    .catch((error) => log.warn("[desktop-web] failed to initialize settings", error));
}
