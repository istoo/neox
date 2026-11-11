import { constants as fsConstants, promises as nodeFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, ipcMain, Notification, shell, systemPreferences } from "electron";

export type OsPermissionKind =
  | "notifications"
  | "microphone"
  | "accessibility"
  | "screenRecording"
  | "fullDiskAccess";

export type OsPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "not-determined"
  | "restricted"
  | "unavailable"
  | "unknown";

export type OsPermissionPlatform = "darwin" | "win32" | "linux" | "other";

export interface OsPermissionSnapshot {
  platform: OsPermissionPlatform;
  checkedAt: number;
  permissions: Record<OsPermissionKind, OsPermissionState>;
}

function platform(): OsPermissionPlatform {
  return process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux"
    ? process.platform
    : "other";
}

function mapMediaAccess(status: string): OsPermissionState {
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "not-determined":
      return "not-determined";
    default:
      return "unknown";
  }
}

function mediaAccessStatus(kind: "microphone" | "screen"): OsPermissionState {
  if (process.platform !== "darwin" && kind === "screen") {
    return "unavailable";
  }
  try {
    return mapMediaAccess(systemPreferences.getMediaAccessStatus(kind));
  } catch {
    return "unknown";
  }
}

/**
 * Full Disk Access has no Electron API. Reading the Safari directory is the
 * conventional probe: success means the grant is on, EACCES proves it is off,
 * and a missing directory leaves the state unknown.
 */
async function fullDiskAccessState(): Promise<OsPermissionState> {
  if (process.platform !== "darwin") {
    return "unavailable";
  }
  const safariDirectory = path.join(os.homedir(), "Library", "Safari");
  try {
    await nodeFs.access(safariDirectory, fsConstants.R_OK | fsConstants.X_OK);
    return "granted";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return "denied";
    }
    return "unknown";
  }
}

function notificationsState(): OsPermissionState {
  return Notification.isSupported() ? "granted" : "unavailable";
}

function accessibilityState(): OsPermissionState {
  if (process.platform !== "darwin") {
    return "unavailable";
  }
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
  } catch {
    return "unknown";
  }
}

export async function getOsPermissionSnapshot(): Promise<OsPermissionSnapshot> {
  const permissions: Record<OsPermissionKind, OsPermissionState> = {
    notifications: notificationsState(),
    microphone: mediaAccessStatus("microphone"),
    accessibility: accessibilityState(),
    screenRecording: mediaAccessStatus("screen"),
    fullDiskAccess: await fullDiskAccessState(),
  };
  return {
    platform: platform(),
    checkedAt: Date.now(),
    permissions,
  };
}

function settingsUrl(kind: OsPermissionKind): string | null {
  if (process.platform === "darwin") {
    switch (kind) {
      case "notifications":
        return "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
      case "microphone":
        return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
      case "accessibility":
        return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
      case "screenRecording":
        return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
      case "fullDiskAccess":
        return "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
    }
  }
  if (process.platform === "win32") {
    switch (kind) {
      case "notifications":
        return "ms-settings:notifications";
      case "microphone":
        return "ms-settings:privacy-microphone";
      default:
        return "ms-settings:privacy";
    }
  }
  return null;
}

export async function openOsPermissionSettings(kind: OsPermissionKind): Promise<boolean> {
  const url = settingsUrl(kind);
  if (!url) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

export async function requestOsPermission(kind: OsPermissionKind): Promise<OsPermissionState> {
  switch (kind) {
    case "microphone": {
      if (process.platform === "darwin") {
        try {
          await systemPreferences.askForMediaAccess("microphone");
        } catch {
          // Fall through to the current observation.
        }
        return mediaAccessStatus("microphone");
      }
      await openOsPermissionSettings(kind);
      return mediaAccessStatus("microphone");
    }
    case "accessibility": {
      if (process.platform === "darwin") {
        try {
          systemPreferences.isTrustedAccessibilityClient(true);
        } catch {
          // Fall through to the current observation.
        }
        return accessibilityState();
      }
      return "unavailable";
    }
    case "screenRecording":
    case "fullDiskAccess":
    case "notifications": {
      // macOS only raises these from the owning app's first use; the settings
      // pane is the actionable surface.
      await openOsPermissionSettings(kind);
      if (kind === "notifications") {
        return notificationsState();
      }
      if (kind === "screenRecording") {
        return mediaAccessStatus("screen");
      }
      return fullDiskAccessState();
    }
    default:
      return "unknown";
  }
}

/** The .app bundle macOS lists in Privacy & Security; dev builds point at Electron. */
export function resolveAppBundlePath(): string | null {
  try {
    const executable = app.getPath("exe");
    if (process.platform === "darwin") {
      const appMarker = executable.indexOf(".app/");
      return appMarker >= 0 ? executable.slice(0, appMarker + ".app".length) : executable;
    }
    return executable;
  } catch {
    return null;
  }
}

async function safariAccessInfo() {
  const snapshot = await getOsPermissionSnapshot();
  // In a dev run the executable is Electron.app, not Neolix; the Safari import
  // setup would point the user at the wrong app.
  if (snapshot.platform !== "darwin" || !app.isPackaged) {
    return { supported: false as const };
  }
  const appPath = resolveAppBundlePath();
  const fullDiskAccess = snapshot.permissions.fullDiskAccess;
  let safariFullDiskAccess: "granted" | "denied" | "unknown" = "unknown";
  if (fullDiskAccess === "granted") {
    safariFullDiskAccess = "granted";
  } else if (fullDiskAccess === "denied") {
    safariFullDiskAccess = "denied";
  }
  return {
    supported: true as const,
    appName: app.name,
    appPath,
    fullDiskAccess: safariFullDiskAccess,
  };
}

export function registerOsPermissionsIpc(): void {
  ipcMain.handle("neolix:os-permissions:state", () => getOsPermissionSnapshot());
  ipcMain.handle("neolix:os-permissions:request", (_event, kind: unknown) => {
    if (typeof kind !== "string") {
      throw new Error("Invalid permission kind");
    }
    return requestOsPermission(kind as OsPermissionKind);
  });
  ipcMain.handle("neolix:os-permissions:open-settings", (_event, kind: unknown) => {
    if (typeof kind !== "string") {
      return false;
    }
    return openOsPermissionSettings(kind as OsPermissionKind);
  });

  ipcMain.handle("neolix:safari-access:info", () => safariAccessInfo());
  ipcMain.handle("neolix:safari-access:open-settings", () =>
    openOsPermissionSettings("fullDiskAccess"),
  );
  ipcMain.handle("neolix:safari-access:reveal-app", () => {
    const appPath = resolveAppBundlePath();
    if (!appPath) {
      return false;
    }
    try {
      shell.showItemInFolder(appPath);
      return true;
    } catch {
      return false;
    }
  });
}
