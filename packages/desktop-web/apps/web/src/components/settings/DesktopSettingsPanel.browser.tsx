// FILE: DesktopSettingsPanel.browser.tsx
// Purpose: Lock the Desktop settings section: it renders only when the Electron
//          shell is present, writes through the shell's command channel, and
//          offers the same renderer switch as the File menu.
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  settings: {
    releaseChannel: "stable",
    notifications: { playSound: true },
    daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
    preventSleep: "off",
    keepAwakeEnabled: false,
    launchAtLogin: false,
    dockVisible: true,
    confirmQuit: false,
    autoCheckUpdates: true,
    updateCheckMinutes: 360,
    autoDownloadUpdates: true,
    autoRestartOnUpdate: false,
    updateMirror: "",
    tray: "window",
    panelShortcut: "",
    language: "",
    trayUsages: [] as string[],
    trayUsageEvery: 3,
    trayNoLogos: false,
    trayNoBird: false,
    trayNoNumber: false,
    trayPace: false,
    trayNoCost: false,
    trayWindows: {} as Record<string, string[]>,
    trayDisplayAs: "used",
    trayCurrency: "usd",
    trayNumberUnits: "compact",
    trayCnyPerUsd: 7.2,
    lightweightMode: true,
    noUpdatePill: false,
  },
  invoke: vi.fn(),
  setMode: vi.fn(async () => undefined),
}));

vi.mock("~/lib/neolixGatewayApi", () => ({
  neolixGatewayApi: {
    getQuota: vi.fn(async () => ({ quota: { accounts: [] } })),
  },
}));

import { DesktopSettingsPanel } from "./DesktopSettingsPanel";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function setBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value });
}

function setShell(value: unknown): void {
  Object.defineProperty(window, "neolixDesktop", { configurable: true, value });
}

beforeEach(() => {
  harness.settings = {
    ...harness.settings,
    preventSleep: "off",
    launchAtLogin: false,
    daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
  };
  harness.invoke.mockReset();
  harness.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_desktop_settings") return harness.settings;
    if (command === "patch_desktop_settings") {
      Object.assign(harness.settings, args ?? {});
      return harness.settings;
    }
    if (command === "desktop_omarchy_widget_status") return { supported: false, enabled: false };
    if (command === "get_cli_install_status") return { installed: false };
    return null;
  });
  harness.setMode.mockClear().mockImplementation(async () => undefined);
  queryClient.clear();
  setShell(undefined);
  setBridge(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  setShell(undefined);
  setBridge(undefined);
});

describe("DesktopSettingsPanel", () => {
  it("renders nothing without the desktop shell", async () => {
    await render(
      <QueryClientProvider client={queryClient}>
        <DesktopSettingsPanel active />
      </QueryClientProvider>,
    );

    expect(document.body.textContent?.trim()).toBe("");
  });

  it("shows the shell preferences when the bridge exists", async () => {
    setShell({ platform: "darwin", invoke: harness.invoke });
    setBridge({
      uiMode: {
        getState: async () => ({ mode: "web", selectable: true }),
        setMode: harness.setMode,
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <DesktopSettingsPanel active />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Desktop app" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("Prevent sleep");
    expect(document.body.textContent).toContain("Open at login");
    expect(document.body.textContent).toContain("Show in Dock");
    expect(document.body.textContent).toContain("Updates");
    expect(document.body.textContent).toContain("Menu bar");
    expect(document.body.textContent).toContain("Neox command line");
    // The rows are localized, not raw keys.
    expect(document.body.textContent).not.toContain("settings:desktop_");
  });

  it("writes the sleep mode through the shell and keeps it on screen", async () => {
    setShell({ platform: "darwin", invoke: harness.invoke });
    setBridge({
      uiMode: {
        getState: async () => ({ mode: "web", selectable: true }),
        setMode: harness.setMode,
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <DesktopSettingsPanel active />
      </QueryClientProvider>,
    );

    await page.getByRole("radio", { name: "Screen on too" }).click();

    await vi.waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith(
        "patch_desktop_settings",
        expect.objectContaining({ preventSleep: "display" }),
      ),
    );
  });

  it("switches the renderer through the dedicated bridge", async () => {
    setShell({ platform: "darwin", invoke: harness.invoke });
    setBridge({
      uiMode: {
        getState: async () => ({ mode: "web", selectable: true }),
        setMode: harness.setMode,
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <DesktopSettingsPanel active />
      </QueryClientProvider>,
    );

    await page.getByRole("radio", { name: "Classic (legacy)" }).click();

    await vi.waitFor(() => expect(harness.setMode).toHaveBeenCalledWith("native"));
  });

  it("does not offer the switch when the environment pins the renderer", async () => {
    setShell({ platform: "darwin", invoke: harness.invoke });
    setBridge({
      uiMode: {
        getState: async () => ({ mode: "web", selectable: false }),
        setMode: harness.setMode,
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <DesktopSettingsPanel active />
      </QueryClientProvider>,
    );

    expect(document.body.textContent).toContain("NEOLIX_DESKTOP_UI");
    expect(document.querySelector('[id="setting-desktop-ui-mode"] [role="radio"]')).toBeNull();
  });
});
