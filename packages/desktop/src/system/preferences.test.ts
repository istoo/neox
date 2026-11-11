import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  powerSaveBlocker: {
    start: vi.fn(() => 7),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
  setLoginItemSettings: vi.fn(),
  getPath: vi.fn(() => "/opt/Neolix/Neolix"),
  dock: { show: vi.fn(async () => undefined), hide: vi.fn() },
}));

const { powerSaveBlocker, setLoginItemSettings, dock } = mocks;

vi.mock("electron", () => ({
  app: {
    setLoginItemSettings: mocks.setLoginItemSettings,
    getPath: mocks.getPath,
    dock: mocks.dock,
  },
  powerSaveBlocker: mocks.powerSaveBlocker,
}));

import {
  applySystemPreferences,
  reportAgentActivity,
  resetPreventSleepForTests,
} from "./preferences";
import { AWAKE_GRACE_MS, AWAKE_STALE_MS } from "./awake";

function mockPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

const BASE = { launchAtLogin: false, dockVisible: true };

let tempHome = "";
const previousEnv: Record<string, string | undefined> = {};

describe("applySystemPreferences", () => {
  beforeEach(() => {
    // Release the previous test's blocker first, so its stop() is not counted.
    resetPreventSleepForTests();
    vi.clearAllMocks();
    mockPlatform("darwin");
    // Never touch the real login record: HOME and the XDG config live in a
    // throwaway directory for the length of the test.
    tempHome = mkdtempSync(path.join(os.tmpdir(), "neolix-preferences-"));
    for (const key of ["HOME", "XDG_CONFIG_HOME"]) {
      previousEnv[key] = process.env[key];
    }
    process.env.HOME = tempHome;
    process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("starts no blocker when prevent sleep is off", () => {
    applySystemPreferences({ ...BASE, preventSleep: "off" });
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("holds nothing while the agents are idle, even with the preference on", () => {
    applySystemPreferences({ ...BASE, preventSleep: "on" });
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("keeps the app running, not only the screen, while an agent is busy", () => {
    applySystemPreferences({ ...BASE, preventSleep: "on" });
    reportAgentActivity(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
  });

  it("keeps the screen awake for the last option", () => {
    applySystemPreferences({ ...BASE, preventSleep: "display" });
    reportAgentActivity(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-display-sleep");
  });

  it("releases after the grace period and does not stack blockers", () => {
    vi.useFakeTimers();
    applySystemPreferences({ ...BASE, preventSleep: "display" });
    reportAgentActivity(true);
    reportAgentActivity(false);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AWAKE_GRACE_MS);
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it("takes a report that stops refreshing as the end of the turn, then waits out the grace", () => {
    vi.useFakeTimers();
    applySystemPreferences({ ...BASE, preventSleep: "on" });
    reportAgentActivity(true);
    vi.advanceTimersByTime(AWAKE_STALE_MS);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AWAKE_GRACE_MS);
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it("opens at login hidden on macOS and Windows", () => {
    applySystemPreferences({ ...BASE, preventSleep: "off", launchAtLogin: true });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true });

    mockPlatform("win32");
    applySystemPreferences({ ...BASE, preventSleep: "off", launchAtLogin: false });
    expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it("writes an XDG autostart entry that opens hidden on Linux", async () => {
    mockPlatform("linux");
    applySystemPreferences({ ...BASE, preventSleep: "off", launchAtLogin: true });

    const entry = path.join(tempHome, ".config", "autostart", "neolix.desktop");
    await vi.waitFor(() => expect(existsSync(entry)).toBe(true));
    expect(readFileSync(entry, "utf8")).toContain("--hidden");
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(dock.hide).not.toHaveBeenCalled();
  });

  it("hides and shows the Dock on macOS only", () => {
    applySystemPreferences({ ...BASE, preventSleep: "off", dockVisible: false });
    expect(dock.hide).toHaveBeenCalledTimes(1);

    applySystemPreferences({ ...BASE, preventSleep: "off", dockVisible: true });
    expect(dock.show).toHaveBeenCalledTimes(1);

    mockPlatform("win32");
    applySystemPreferences({ ...BASE, preventSleep: "off", dockVisible: false });
    expect(dock.hide).toHaveBeenCalledTimes(1);
  });
});
