import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildTrayMenuTemplate, normalizePanelShortcut, resolveTrayIconPath } from "./tray";

describe("normalizePanelShortcut", () => {
  it("takes nothing as no shortcut", () => {
    expect(normalizePanelShortcut("", "darwin")).toEqual({ accelerator: null });
    expect(normalizePanelShortcut("   ", "darwin")).toEqual({ accelerator: null });
  });

  it("writes Electron's accelerator, with Command on a Mac and Super elsewhere", () => {
    expect(normalizePanelShortcut("Cmd+Shift+M", "darwin")).toEqual({
      accelerator: "Shift+Command+M",
    });
    expect(normalizePanelShortcut("Super+Shift+M", "linux")).toEqual({
      accelerator: "Shift+Super+M",
    });
    expect(normalizePanelShortcut("ctrl+option+k", "darwin")).toEqual({
      accelerator: "Control+Alt+K",
    });
  });

  it("allows a function key alone but not a bare letter", () => {
    expect(normalizePanelShortcut("F9", "win32")).toEqual({ accelerator: "F9" });
    expect(normalizePanelShortcut("K", "darwin")).toEqual({
      accelerator: null,
      error: "not-shortcut",
    });
    expect(normalizePanelShortcut("Shift+K", "darwin")).toEqual({
      accelerator: null,
      error: "not-shortcut",
    });
  });

  it("refuses keys myna refuses", () => {
    for (const raw of ["Ctrl+Escape", "Ctrl+F21", "Hyper+K", "Ctrl+"]) {
      expect(normalizePanelShortcut(raw, "darwin")).toEqual({
        accelerator: null,
        error: "not-shortcut",
      });
    }
  });
});

describe("buildTrayMenuTemplate", () => {
  it("is Open, Version, then Quit, as myna's menu", () => {
    const items = buildTrayMenuTemplate({ open: "Open", version: "Version 1.0.0", quit: "Quit" });
    expect(items.map((item) => item.id)).toEqual(["open", "version", "separator", "quit"]);
    expect(items[1]?.enabled).toBe(false);
  });
});

describe("resolveTrayIconPath", () => {
  it("reads resources when packaged and assets in dev", () => {
    const resourcesPath = "/app/resources";
    const assetsDir = "/repo/packages/desktop/assets";
    expect(
      resolveTrayIconPath({
        isPackaged: true,
        resourcesPath,
        assetsDir,
        platform: "darwin",
      }),
    ).toBe(path.join(resourcesPath, "tray", "trayTemplate.png"));
    expect(
      resolveTrayIconPath({
        isPackaged: false,
        resourcesPath,
        assetsDir,
        platform: "win32",
      }),
    ).toBe(path.join(assetsDir, "tray", "tray.png"));
  });

  it("points at files that exist in this checkout", () => {
    // The dev path used to resolve to dist/assets, which does not exist: an empty tray.
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const iconPath = resolveTrayIconPath({
        isPackaged: false,
        resourcesPath: "/unused",
        assetsDir: path.resolve(__dirname, "..", "..", "assets"),
        platform,
      });
      expect(existsSync(iconPath)).toBe(true);
    }
  });
});
