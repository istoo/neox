import { describe, expect, it } from "vitest";

import {
  clearPanelClicks,
  currentPanelPlacement,
  isClickOutside,
  isHyprland,
  monitorSize,
  panelAt,
  type HyprMonitor,
} from "./hyprland-panel";

const VIRTUAL: HyprMonitor = {
  name: "Virtual-1",
  x: 0,
  y: 0,
  width: 2528,
  height: 960,
  scale: 1.6,
  transform: 0,
  reserved: [0, 26, 0, 0],
};
const TURNED: HyprMonitor = {
  name: "DP-1",
  x: 1580,
  y: 0,
  width: 1920,
  height: 1080,
  scale: 1,
  transform: 1,
  reserved: [0, 0, 0, 0],
};

describe("hyprland panel", () => {
  it("knows Hyprland from the session", () => {
    expect(isHyprland({ HYPRLAND_INSTANCE_SIGNATURE: "sig" }, "linux")).toBe(true);
    expect(isHyprland({}, "linux")).toBe(false);
    expect(isHyprland({ HYPRLAND_INSTANCE_SIGNATURE: "sig" }, "darwin")).toBe(false);
  });

  it("measures a scaled or turned monitor in layout coordinates", () => {
    expect(monitorSize(VIRTUAL)).toEqual({ width: 1580, height: 600 });
    expect(monitorSize(TURNED)).toEqual({ width: 1080, height: 1920 });
  });

  it("places the panel under the bar, centered on the click", () => {
    expect(panelAt(440, 800, 10, [VIRTUAL])).toEqual({
      monitor: "Virtual-1",
      x: 580,
      y: 32,
      maxHeight: 562,
    });
    // Clamped at the left and right edges.
    expect(panelAt(440, 20, 10, [VIRTUAL])).toMatchObject({ x: 6 });
    expect(panelAt(440, 1570, 10, [VIRTUAL])).toMatchObject({ x: 1580 - 6 - 440 });
  });

  it("uses the monitor's own corner for a monitor not at 0,0", () => {
    expect(panelAt(440, 1700, 1500, [VIRTUAL, TURNED])).toEqual({
      monitor: "DP-1",
      x: 6,
      y: 6,
      maxHeight: 1920 - 6 - 6,
    });
  });

  it("is null off every monitor", () => {
    expect(panelAt(440, -5, 10, [VIRTUAL])).toBeNull();
  });

  it("reads the placement from hyprctl", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[1] === "cursorpos") return JSON.stringify({ x: 800, y: 10 });
      if (args[1] === "monitors") return JSON.stringify([VIRTUAL]);
      return "";
    };
    expect(await currentPanelPlacement(440, run)).toMatchObject({ monitor: "Virtual-1", x: 580 });
  });

  it("leaves a click on the bar to the icon, and closes off the panel", () => {
    const panel = { at: [500, 40] as [number, number], size: [400, 300] as [number, number] };
    expect(isClickOutside({ x: 600, y: 100 }, panel)).toBe(false);
    expect(isClickOutside({ x: 600, y: 10 }, panel)).toBe(false); // the bar
    expect(isClickOutside({ x: 100, y: 100 }, panel)).toBe(true);
    expect(isClickOutside({ x: 600, y: 400 }, panel)).toBe(true);
  });

  it("drops a leftover panel bind before this run installs its own", async () => {
    const calls: readonly string[][] = [];
    const run = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      return "";
    };

    await clearPanelClicks(run);

    expect(calls[0]?.[0]).toBe("eval");
    expect(calls[0]?.[1]).toContain('unbind("mouse:272")');
  });

  it("ignores a Hyprland that cannot unbind", async () => {
    const run = async (): Promise<string> => {
      throw new Error("hyprctl eval failed");
    };

    await expect(clearPanelClicks(run)).resolves.toBeUndefined();
  });
});
