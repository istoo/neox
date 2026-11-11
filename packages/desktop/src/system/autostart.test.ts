import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HIDDEN_ARG,
  execPathFromEntry,
  getAutostartState,
  launchedHidden,
  linuxAutostartPath,
  linuxDesktopEntry,
  refreshAutostart,
  replaceExecLine,
  setAutostart,
  type AutostartHost,
  type LoginItemSettings,
} from "./autostart";

let tempHome = "";

function makeHost(
  overrides: Partial<AutostartHost> & { loginItem?: LoginItemSettings } = {},
): AutostartHost & { setLoginItemSettings: ReturnType<typeof vi.fn> } {
  const loginItem = overrides.loginItem ?? { openAtLogin: false };
  const setLoginItemSettings = vi.fn();
  return {
    platform: "linux",
    execPath: "/opt/Neolix/Neolix",
    env: { HOME: tempHome, XDG_CONFIG_HOME: path.join(tempHome, ".config") },
    fs: {
      readFile: (filePath, encoding) =>
        import("node:fs/promises").then((fs) => fs.readFile(filePath, encoding)),
      writeFile: (filePath, data, encoding) =>
        import("node:fs/promises").then((fs) => fs.writeFile(filePath, data, encoding)),
      mkdir: (dirPath, options) =>
        import("node:fs/promises").then((fs) => fs.mkdir(dirPath, options)),
      rm: (filePath, options) => import("node:fs/promises").then((fs) => fs.rm(filePath, options)),
    },
    getLoginItemSettings: () => loginItem,
    setLoginItemSettings,
    ...overrides,
  };
}

describe("autostart", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "neolix-autostart-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("follows XDG_CONFIG_HOME, then HOME", () => {
    expect(linuxAutostartPath({ HOME: "/home/u" })).toBe(
      "/home/u/.config/autostart/neolix.desktop",
    );
    expect(linuxAutostartPath({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" })).toBe(
      "/cfg/autostart/neolix.desktop",
    );
  });

  it("writes an entry that starts the tray only, and removes it when turned off", async () => {
    const host = makeHost();
    expect(await getAutostartState(host)).toBe("off");

    await setAutostart(host, true);
    expect(await getAutostartState(host)).toBe("on");
    const entry = readFileSync(linuxAutostartPath(host.env), "utf8");
    expect(entry).toContain(HIDDEN_ARG);

    await setAutostart(host, false);
    expect(await getAutostartState(host)).toBe("off");
    expect(existsSync(linuxAutostartPath(host.env))).toBe(false);
  });

  it("quotes an executable path with spaces", () => {
    const entry = linuxDesktopEntry("/Applications/My Apps/Neolix");
    expect(entry).toContain('Exec="/Applications/My Apps/Neolix" --hidden');
    expect(execPathFromEntry(entry)).toBe("/Applications/My Apps/Neolix");
  });

  it("reads a record the user disabled as off", async () => {
    const host = makeHost();
    await setAutostart(host, true);
    const filePath = linuxAutostartPath(host.env);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${linuxDesktopEntry(host.execPath)}Hidden=true\n`);
    expect(await getAutostartState(host)).toBe("off");

    writeFileSync(
      filePath,
      linuxDesktopEntry(host.execPath).replace("enabled=true", "enabled=false"),
    );
    expect(await getAutostartState(host)).toBe("off");
  });

  it("repoints a moved executable without turning a disabled record back on", async () => {
    const host = makeHost();
    await setAutostart(host, true);
    const filePath = linuxAutostartPath(host.env);
    writeFileSync(filePath, `${linuxDesktopEntry(host.execPath)}Hidden=true\n`);

    const moved = makeHost({ execPath: "/opt/Neolix 2/Neolix" });
    await refreshAutostart(moved);

    const entry = readFileSync(filePath, "utf8");
    expect(execPathFromEntry(entry)).toBe("/opt/Neolix 2/Neolix");
    expect(entry).toContain("Hidden=true");
    expect(await getAutostartState(moved)).toBe("off");
  });

  it("keeps other lines when replacing Exec", () => {
    const entry = "[Desktop Entry]\nType=Application\nExec=old\nHidden=true\n";
    expect(replaceExecLine(entry, "/new")).toBe(
      '[Desktop Entry]\nType=Application\nExec="/new" --hidden\nHidden=true\n',
    );
  });

  it("reports a macOS login item the user switched off as needing allowing", async () => {
    const host = makeHost({
      platform: "darwin",
      loginItem: { openAtLogin: true, status: "requires-approval" },
    });
    expect(await getAutostartState(host)).toBe("allow");

    const enabled = makeHost({
      platform: "darwin",
      loginItem: { openAtLogin: true, status: "enabled" },
    });
    expect(await getAutostartState(enabled)).toBe("on");
  });

  it("writes a hidden login item on macOS and Windows", async () => {
    const mac = makeHost({ platform: "darwin" });
    await setAutostart(mac, true);
    expect(mac.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
    });

    const win = makeHost({ platform: "win32" });
    await setAutostart(win, true);
    expect(win.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [HIDDEN_ARG],
    });
  });

  it("repoints a Windows record only when it is still on and stale", async () => {
    const stale = makeHost({
      platform: "win32",
      loginItem: { openAtLogin: true, executableWillLaunchAtLogin: false },
    });
    await refreshAutostart(stale);
    expect(stale.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "/opt/Neolix/Neolix",
      args: [HIDDEN_ARG],
    });

    const off = makeHost({
      platform: "win32",
      loginItem: { openAtLogin: false, executableWillLaunchAtLogin: false },
    });
    await refreshAutostart(off);
    expect(off.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("knows a login launch from argv and macOS's flag", () => {
    expect(
      launchedHidden({
        platform: "linux",
        argv: ["neolix", HIDDEN_ARG],
        loginItem: { openAtLogin: true },
      }),
    ).toBe(true);
    expect(
      launchedHidden({
        platform: "darwin",
        argv: ["neolix"],
        loginItem: { openAtLogin: true, wasOpenedAtLogin: true, wasOpenedAsHidden: true },
      }),
    ).toBe(true);
    expect(
      launchedHidden({
        platform: "darwin",
        argv: ["neolix"],
        loginItem: { openAtLogin: true, wasOpenedAtLogin: true, wasOpenedAsHidden: false },
      }),
    ).toBe(false);
  });
});
