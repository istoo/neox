import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trayState = vi.hoisted(() => ({ title: "", tooltip: "", image: null as unknown }));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3", getLocale: () => "en-US" },
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  Tray: class {
    setToolTip(tooltip: string) {
      trayState.tooltip = tooltip;
    }
    setTitle(title: string) {
      trayState.title = title;
    }
    setImage(image: unknown) {
      trayState.image = image;
    }
    on() {}
    setContextMenu() {}
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({ resize: vi.fn(() => ({})) })),
    createFromDataURL: vi.fn(() => ({ setTemplateImage: vi.fn() })),
    createFromBuffer: vi.fn(() => ({})),
    createEmpty: vi.fn(() => ({})),
  },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
}));

import { Menu, nativeImage } from "electron";

import {
  applyTraySettings,
  installDesktopTray,
  resetTrayForTests,
  resolveTrayLanguage,
  setTrayLanguage,
  setTrayUsage,
} from "./tray-manager";

function lastMenuLabels(): string[] {
  const calls = vi.mocked(Menu.buildFromTemplate).mock.calls;
  const template = calls.at(-1)?.[0] as { label?: string; type?: string }[] | undefined;
  return (template ?? [])
    .filter((item) => item.type !== "separator")
    .map((item) => item.label ?? "");
}

describe("resolveTrayLanguage", () => {
  it("takes an exact language code", () => {
    expect(resolveTrayLanguage("ja", "en-US")).toBe("ja");
    expect(resolveTrayLanguage("pt-BR", "en-US")).toBe("pt-BR");
  });

  it("maps a base code or the system locale to the shipped one", () => {
    expect(resolveTrayLanguage("zh", "en-US")).toBe("zh-CN");
    expect(resolveTrayLanguage("zh-Hans-CN", "en-US")).toBe("zh-CN");
    expect(resolveTrayLanguage("pt", "en-US")).toBe("pt-BR");
    expect(resolveTrayLanguage(undefined, "ru_RU.UTF-8")).toBe("ru");
    expect(resolveTrayLanguage("system", "de-DE")).toBe("en");
  });

  it("falls back to the system locale when the setting says nothing usable", () => {
    expect(resolveTrayLanguage("klingon", "fr-FR")).toBe("fr");
  });
});

describe("tray readings", () => {
  beforeEach(() => {
    resetTrayForTests();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    vi.mocked(nativeImage.createFromBuffer).mockClear();
    vi.mocked(nativeImage.createFromDataURL).mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the renderer's reading while it is fresh, then takes the poller's", () => {
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });
    setTrayUsage({ label: "Claude 62%", tooltip: "renderer" });

    setTrayUsage({ label: "62%", tooltip: "main" }, "main");
    expect(trayState.tooltip).toBe("renderer");

    // Past the quiet window the main process's own reading takes over.
    vi.setSystemTime(1_000_000 + 200_000);
    setTrayUsage({ label: "62%", tooltip: "main" }, "main");
    expect(trayState.tooltip).toBe("main");
  });

  it("draws a provider's mark as the menu bar icon when Neolix's own is off", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    applyTraySettings({
      tray: "window",
      panelShortcut: "",
      language: "en",
      trayNoBird: true,
      trayNoNumber: false,
      trayUsageEvery: 3,
    });
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });

    setTrayUsage({
      label: "62%",
      tooltip: "Claude",
      logoDataUrl: "data:image/png;base64,AA",
    });

    const image = vi.mocked(nativeImage.createFromDataURL).mock.results.at(-1)?.value;
    expect(image?.setTemplateImage).toHaveBeenCalledWith(true);
  });

  it("keeps the main process's provider mark when the renderer pushes text only", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    applyTraySettings({
      tray: "window",
      panelShortcut: "",
      language: "en",
      trayNoBird: true,
      trayNoNumber: false,
      trayUsageEvery: 3,
    });
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });
    const logo = "data:image/png;base64,MAIN";
    setTrayUsage({ label: "62%", tooltip: "main", logoDataUrl: logo }, "main");
    vi.mocked(nativeImage.createFromDataURL).mockClear();
    vi.mocked(nativeImage.createEmpty).mockClear();

    // tray-usage.tsx has no provider marks, so it omits logoDataUrl.
    setTrayUsage({ label: "62% +3%", tooltip: "renderer" });

    expect(nativeImage.createFromDataURL).toHaveBeenCalledWith(logo);
    expect(nativeImage.createEmpty).not.toHaveBeenCalled();
  });

  it("clears the provider mark when the renderer says null", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    applyTraySettings({
      tray: "window",
      panelShortcut: "",
      language: "en",
      trayNoBird: true,
      trayNoNumber: false,
      trayUsageEvery: 3,
    });
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });
    setTrayUsage(
      { label: "62%", tooltip: "main", logoDataUrl: "data:image/png;base64,AA" },
      "main",
    );
    vi.mocked(nativeImage.createEmpty).mockClear();

    setTrayUsage({ label: "", tooltip: "Neox", logoDataUrl: null });

    expect(nativeImage.createEmpty).toHaveBeenCalled();
  });

  it("draws the Windows tray icon as the first figure", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    applyTraySettings({
      tray: "window",
      panelShortcut: "",
      language: "en",
      trayNoBird: false,
      trayNoNumber: false,
      trayUsageEvery: 3,
    });
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });

    setTrayUsage({ label: "Claude 62% +3%", tooltip: "Claude" });

    expect(nativeImage.createFromBuffer).toHaveBeenCalled();
    expect(trayState.image).toBe(
      vi.mocked(nativeImage.createFromBuffer).mock.results.at(-1)?.value,
    );
  });

  it("keeps Neolix's icon when the tray number is off", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    applyTraySettings({
      tray: "window",
      panelShortcut: "",
      language: "en",
      trayNoBird: false,
      trayNoNumber: true,
      trayUsageEvery: 3,
    });
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });

    setTrayUsage({ label: "Claude 62%", tooltip: "Claude" });

    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });
});

describe("tray menu language", () => {
  beforeEach(() => {
    resetTrayForTests();
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  it("uses the saved language at startup, before any renderer pushes one", () => {
    applyTraySettings({
      tray: "window",
      panelShortcut: "",
      language: "ja",
      trayNoBird: false,
      trayNoNumber: false,
      trayUsageEvery: 3,
    });
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });

    expect(lastMenuLabels()[0]).toBe("Neox を開く");
  });

  it("follows a push made while the tray is already up", () => {
    installDesktopTray({ onShowWindow: () => undefined, onTogglePanel: () => undefined });
    expect(lastMenuLabels()[0]).toBe("Open Neox");

    setTrayLanguage("zh-CN");

    expect(lastMenuLabels()[0]).toBe("打开 Neox");
  });
});
