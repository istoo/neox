import path from "node:path";

import { Menu, Tray, app, globalShortcut, nativeImage, nativeTheme } from "electron";
import log from "electron-log/main";
import { trayFigure } from "@neolix/protocol/tray-usage-model";

import {
  DEFAULT_TRAY_CLICK,
  buildTrayMenuTemplate,
  normalizePanelShortcut,
  resolveTrayIconPath,
  type TrayClickAction,
} from "./tray.js";
import { trayNumberPng } from "./tray-number-icon.js";

/**
 * The running tray and its global shortcut, as myna keeps them in app.go.
 * Kept out of main.ts so the settings command handlers can re-apply a
 * changed click behavior or shortcut without importing the entry point.
 */

let tray: Tray | null = null;
let clickAction: TrayClickAction = DEFAULT_TRAY_CLICK;
let registeredShortcut: string | null = null;
let showWindow: () => void = () => undefined;
/**
 * The tray's click and the shortcut both open the quick panel when the
 * setting says panel; the shortcut always opens it, as myna's does
 * (panelkey.go). The anchor is where the tray icon is, or null for a
 * shortcut (the panel follows the pointer).
 */
let togglePanel: (anchor: Electron.Rectangle | null) => void = () => undefined;

export type TrayLanguage = "en" | "zh-CN" | "ar" | "es" | "fr" | "ja" | "ko" | "pt-BR" | "ru";

interface TrayLabels {
  open: string;
  version: string;
  quit: string;
}

/** myna's trayWords table (traymenu.go), kept in this process. */
const TRAY_LABELS: Record<TrayLanguage, TrayLabels> = {
  en: { open: "Open Neox", version: "Version", quit: "Quit Neox" },
  "zh-CN": { open: "打开 Neox", version: "版本", quit: "退出 Neox" },
  ar: { open: "فتح Neox", version: "الإصدار", quit: "إنهاء Neox" },
  es: { open: "Abrir Neox", version: "Versión", quit: "Salir de Neox" },
  fr: { open: "Ouvrir Neox", version: "Version", quit: "Quitter Neox" },
  ja: { open: "Neox を開く", version: "バージョン", quit: "Neox を終了" },
  ko: { open: "Neox 열기", version: "버전", quit: "Neox 종료" },
  "pt-BR": { open: "Abrir o Neox", version: "Versão", quit: "Sair do Neox" },
  ru: { open: "Открыть Neox", version: "Версия", quit: "Выйти из Neox" },
};

let language: TrayLanguage | null = null;

/** What the menu bar says beside the icon, pushed by the renderer or read here. */
export interface TrayUsageState {
  /** macOS menu-bar text; "" clears it. */
  label: string;
  tooltip: string;
  /**
   * macOS: a provider's mark, shown when Neolix's own icon is off (myna draws
   * the mark as part of the menu-bar image). Null keeps the name in the text.
   */
  logoDataUrl?: string | null;
}

let trayUsage: TrayUsageState = { label: "", tooltip: "Neox" };
let trayImage: Electron.NativeImage | null = null;
/** Windows' figure icon, rebuilt whenever the label or the taskbar colour changes. */
let numberIcon: Buffer | null = null;
let trayNoBird = false;
let trayNoNumber = false;
/** When the renderer last pushed a reading; "" means it never has. */
let lastRendererPushAt = 0;
/**
 * How long a renderer reading wins over the main process's own poll. The
 * renderer polls at the interval Settings names, so a window that is merely
 * hidden keeps winning, and a closed one hands the tray back after this.
 */
let rendererQuietMs = 120_000;
/** The main process's poller, re-read as soon as Settings changes. */
let refreshUsage: () => void = () => undefined;

export function setTrayUsageRefresher(refresh: (() => void) | null): void {
  refreshUsage = refresh ?? (() => undefined);
}

export function refreshTrayUsage(): void {
  refreshUsage();
}

/**
 * The language the tray speaks, as the Settings page picks it: the exact
 * code, a language's base code, or the system's locale (myna's trayLang).
 */
export function resolveTrayLanguage(
  preference: string | undefined,
  systemLocale: string,
): TrayLanguage {
  const supported = Object.keys(TRAY_LABELS) as TrayLanguage[];
  const chosen = preference?.trim();
  if (chosen && chosen !== "system") {
    const exact = supported.find((code) => code.toLowerCase() === chosen.toLowerCase());
    if (exact) {
      return exact;
    }
    const base = chosen.toLowerCase().split("-")[0];
    if (base === "zh") return "zh-CN";
    if (base === "pt") return "pt-BR";
    const byBase = supported.find((code) => code.toLowerCase().split("-")[0] === base);
    if (byBase) {
      return byBase;
    }
  }
  return resolveTrayLanguageFromLocale(systemLocale);
}

function resolveTrayLanguageFromLocale(locale: string): TrayLanguage {
  const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
  const base = normalized.split("-")[0];
  switch (base) {
    case "zh":
      return "zh-CN";
    case "pt":
      return "pt-BR";
    case "ar":
    case "es":
    case "fr":
    case "ja":
    case "ko":
    case "ru":
      return base;
    default:
      return "en";
  }
}

/** The Settings page's language, pushed by the renderer; system locale before it. */
export function setTrayLanguage(preference: string): void {
  const next = resolveTrayLanguage(preference, app.getLocale());
  if (next === language) {
    return;
  }
  language = next;
  refreshMenu();
}

export function currentTrayLanguage(): TrayLanguage {
  return currentLanguage();
}

function currentLanguage(): TrayLanguage {
  return language ?? resolveTrayLanguageFromLocale(app.getLocale());
}

function labels(): TrayLabels {
  return TRAY_LABELS[currentLanguage()];
}

function onTrayActivate(anchor: Electron.Rectangle | null): void {
  if (clickAction === "panel") {
    togglePanel(anchor);
    return;
  }
  showWindow();
}

function refreshMenu(): void {
  if (!tray) {
    return;
  }
  const version = app.getVersion();
  const current = labels();
  const items = buildTrayMenuTemplate({
    open: current.open,
    version: `${current.version} ${version}`,
    quit: current.quit,
  }).map((item) => {
    if (item.type === "separator") {
      return { type: "separator" as const };
    }
    if (item.id === "open") {
      return { label: item.label, click: () => showWindow() };
    }
    if (item.id === "quit") {
      return { label: item.label, click: () => app.quit() };
    }
    return { label: item.label, enabled: false };
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** Puts the tray icon up. Call once, after app.whenReady(). */
export function installDesktopTray(options: {
  onShowWindow: () => void;
  onTogglePanel: (anchor: Electron.Rectangle | null) => void;
}): void {
  showWindow = options.onShowWindow;
  togglePanel = options.onTogglePanel;
  if (tray) {
    return;
  }
  const iconPath = resolveTrayIconPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // This module compiles to dist/system/, two levels below packages/desktop.
    assetsDir: path.resolve(__dirname, "..", "..", "assets"),
    platform: process.platform,
  });
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // An empty image still reserves a menu bar slot but draws nothing; say where it looked.
    log.warn("[tray] icon not found or unreadable", iconPath);
  }
  // The tray assets are drawn at the menu bar's size (with @2x beside them); resizing would
  // drop the Retina representation, so only an unexpectedly large file is scaled down.
  const size = process.platform === "darwin" ? 18 : 32;
  trayImage = image.getSize().width > size ? image.resize({ width: size, height: size }) : image;
  if (process.platform === "darwin") trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.setToolTip("Neox");
  tray.on("click", (_event, bounds) => onTrayActivate(bounds ?? null));
  // Before the renderer says otherwise, the saved language or the system's.
  // applyTraySettings runs first at startup, so a login launch has the saved
  // one; the system locale only fills a first run.
  if (language === null) {
    language = resolveTrayLanguageFromLocale(app.getLocale());
  }
  // The taskbar turned dark or light: redraw the figure in its colour, as
  // myna listens for Windows' SystemThemeChanged.
  nativeTheme.on("updated", () => {
    numberIcon = buildNumberIcon(trayUsage.label);
    applyTrayImage();
  });
  refreshMenu();
}

export function isDesktopTrayInstalled(): boolean {
  return tray !== null;
}

/** Binds myna's PanelShortcut (panelkey.go); false when another app holds it. */
export function applyPanelShortcut(raw: string): boolean {
  const result = normalizePanelShortcut(raw, process.platform);
  if (result.error) {
    return false;
  }
  if (result.accelerator === registeredShortcut) {
    return true;
  }
  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut);
    registeredShortcut = null;
  }
  if (!result.accelerator) {
    return true;
  }
  // myna's shortcut always opens the quick panel, whatever the tray click does.
  if (!globalShortcut.register(result.accelerator, () => togglePanel(null))) {
    return false;
  }
  registeredShortcut = result.accelerator;
  return true;
}

export function applyTraySettings(settings: {
  tray: TrayClickAction;
  panelShortcut: string;
  language: string;
  trayNoBird: boolean;
  trayNoNumber: boolean;
  trayUsageEvery: number;
}): void {
  clickAction = settings.tray;
  applyPanelShortcut(settings.panelShortcut);
  // "" means the settings never named one: resolveTrayLanguage falls back to
  // the system locale, as myna's trayLang does.
  setTrayLanguage(settings.language);
  trayNoBird = settings.trayNoBird;
  trayNoNumber = settings.trayNoNumber;
  rendererQuietMs = Math.max(120_000, settings.trayUsageEvery * 60_000 * 1.5 + 10_000);
  applyTrayImage();
}

/**
 * Puts the icon back where it belongs: Neolix's own, none while "Menu bar
 * Neolix icon" is off (macOS), or the first figure on Windows' taskbar
 * (myna's traynumber.go), which "Tray icon number" keeps Neolix's.
 */
function applyTrayImage(): void {
  if (!tray) {
    return;
  }
  if (process.platform === "win32" && !trayNoNumber && numberIcon !== null) {
    tray.setImage(nativeImage.createFromBuffer(numberIcon));
    return;
  }
  if (process.platform === "darwin" && trayNoBird) {
    const logoDataUrl = trayUsage.logoDataUrl ?? null;
    if (logoDataUrl === null) {
      tray.setImage(nativeImage.createEmpty());
      return;
    }
    // A template image takes the menu bar's own colour, as myna's glyphs do.
    const logo = nativeImage.createFromDataURL(logoDataUrl);
    logo.setTemplateImage(true);
    tray.setImage(logo);
    return;
  }
  if (trayImage) {
    tray.setImage(trayImage);
  }
}

/**
 * A reading for the menu bar. The renderer's wins while it keeps pushing; the
 * main process's poll fills a tray-only launch, where no renderer exists.
 */
export function setTrayUsage(
  state: TrayUsageState,
  source: "main" | "renderer" = "renderer",
): void {
  const now = Date.now();
  if (source === "main" && now - lastRendererPushAt < rendererQuietMs) {
    return;
  }
  if (source === "renderer") {
    lastRendererPushAt = now;
  }
  // The renderer has no provider marks; it pushes text only. Undefined keeps
  // the mark the main process's poll computed, null clears it explicitly.
  trayUsage = {
    label: state.label,
    tooltip: state.tooltip,
    logoDataUrl: state.logoDataUrl === undefined ? trayUsage.logoDataUrl : state.logoDataUrl,
  };
  numberIcon = buildNumberIcon(state.label);
  if (!tray) {
    return;
  }
  const label = state.label.trim();
  if (process.platform === "darwin") {
    // The menu bar sets the text hard against the icon (myna does the same).
    tray.setTitle(label === "" || trayNoBird ? label : ` ${label}`);
  }
  tray.setToolTip(state.tooltip.trim() || "Neox");
  applyTrayImage();
}

/** Windows' tray icon as the menu bar's first figure, in the taskbar's colour. */
function buildNumberIcon(label: string): Buffer | null {
  const figure = trayFigure(label);
  if (figure === null) {
    return null;
  }
  const color = nativeTheme.shouldUseDarkColors
    ? { r: 255, g: 255, b: 255 }
    : { r: 26, g: 26, b: 26 };
  const png = trayNumberPng(figure, color);
  return png === null ? null : Buffer.from(png);
}

/** Test seam: forget the tray without touching the OS. */
export function resetTrayForTests(): void {
  tray = null;
  trayImage = null;
  trayUsage = { label: "", tooltip: "Neox" };
  numberIcon = null;
  trayNoBird = false;
  trayNoNumber = false;
  lastRendererPushAt = 0;
  rendererQuietMs = 120_000;
  refreshUsage = () => undefined;
  clickAction = DEFAULT_TRAY_CLICK;
  registeredShortcut = null;
  showWindow = () => undefined;
  togglePanel = () => undefined;
  language = null;
}
