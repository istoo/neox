import { promises as nodeFs } from "node:fs";
import { app, powerSaveBlocker } from "electron";

import type { DesktopSettings, PreventSleepMode } from "../settings/desktop-settings.js";
import { createAwakeController, type AwakeController } from "./awake.js";
import { setAutostart, type AutostartHost } from "./autostart.js";

let sleepBlockerId: number | null = null;
let awakeController: AwakeController | null = null;
let lastLaunchAtLogin: boolean | null = null;

/** Settings that change the operating system's behavior rather than the app's. */
export type SystemPreferences = Pick<
  DesktopSettings,
  "preventSleep" | "launchAtLogin" | "dockVisible" | "lightweightMode"
>;

let lightweightMode = true;

/**
 * myna's Lightweight mode: on, a closed window frees its renderer (Electron
 * destroys it); off, the window is hidden instead and reopens as it was.
 */
export function shouldHideWindowOnClose(): boolean {
  return !lightweightMode;
}

/**
 * Applies prevent-sleep, launch-at-login and Dock visibility. Safe to call
 * repeatedly: each one replaces the previous state, and a platform that has no
 * such control is left alone.
 */
export function applySystemPreferences(settings: SystemPreferences): void {
  applyPreventSleep(settings.preventSleep);
  applyLaunchAtLogin(settings.launchAtLogin);
  applyDockVisibility(settings.dockVisible);
  lightweightMode = settings.lightweightMode;
}

/**
 * myna holds sleep off only while agents work (awake.go:61 Keep), so turning
 * the preference on arms the controller instead of taking the blocker now.
 */
function applyPreventSleep(mode: PreventSleepMode): void {
  getAwakeController().setMode(mode);
}

/** Turns opening at login off before uninstalling, on every platform. */
export async function disableAutostartForUninstall(): Promise<void> {
  const host: AutostartHost = {
    platform: process.platform,
    execPath: process.env.APPIMAGE?.trim() || app.getPath("exe"),
    env: process.env,
    fs: nodeFs,
    getLoginItemSettings: () => app.getLoginItemSettings(),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  };
  await setAutostart(host, false);
  lastLaunchAtLogin = false;
}

/**
 * The renderer's report of whether any agent is running or the gateway has a
 * request in flight. The controller adds myna's grace period.
 */
export function reportAgentActivity(busy: boolean): void {
  getAwakeController().reportBusy(busy);
}

function getAwakeController(): AwakeController {
  awakeController ??= createAwakeController({
    start: (level) => {
      sleepBlockerId = powerSaveBlocker.start(
        level === "display" ? "prevent-display-sleep" : "prevent-app-suspension",
      );
    },
    stop: () => {
      if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
        powerSaveBlocker.stop(sleepBlockerId);
      }
      sleepBlockerId = null;
    },
  });
  return awakeController;
}

/**
 * Writes the system's login record — macOS, Windows, and Linux's XDG
 * autostart entry (autostart.go:53). Applied only when it changes, so an
 * unrelated settings save does not overwrite a record the user edited.
 */
function applyLaunchAtLogin(enabled: boolean): void {
  if (lastLaunchAtLogin === enabled) {
    return;
  }
  lastLaunchAtLogin = enabled;
  const host: AutostartHost = {
    platform: process.platform,
    execPath: process.env.APPIMAGE?.trim() || app.getPath("exe"),
    env: process.env,
    fs: nodeFs,
    getLoginItemSettings: () => app.getLoginItemSettings(),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  };
  void setAutostart(host, enabled).catch((error) => {
    console.error("[autostart] failed to write the login record", error);
  });
}

function applyDockVisibility(visible: boolean): void {
  if (process.platform !== "darwin") {
    return;
  }
  if (visible) {
    void app.dock?.show().catch(() => undefined);
    return;
  }
  app.dock?.hide();
}

/** Test seam: release the controller and forget the blocker without touching the OS. */
export function resetPreventSleepForTests(): void {
  awakeController?.dispose();
  awakeController = null;
  sleepBlockerId = null;
  lastLaunchAtLogin = null;
  lightweightMode = true;
}
