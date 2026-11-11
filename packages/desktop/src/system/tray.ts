import path from "node:path";

/**
 * myna's tray (magpie/internal/gui/traymenu.go, panelkey.go): the menu has
 * Open, the version and Quit; a click opens the quick panel or the window;
 * and an optional global shortcut opens the panel from any app.
 *
 * Neolix has no separate quick panel, so both click choices bring up the main
 * window: "panel" toggles it (a second click hides it), "window" focuses it.
 */
export type TrayClickAction = "window" | "panel";

export const DEFAULT_TRAY_CLICK: TrayClickAction = "window";

export function isTrayClickAction(value: unknown): value is TrayClickAction {
  return value === "window" || value === "panel";
}

export interface TrayMenuLabels {
  open: string;
  version: string;
  quit: string;
}

export interface TrayMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  type: "normal" | "separator";
}

/**
 * The tray menu, in myna's order: open, version (a disabled line, as myna
 * shows it), then quit.
 */
export function buildTrayMenuTemplate(labels: TrayMenuLabels): TrayMenuItem[] {
  return [
    { id: "open", label: labels.open, enabled: true, type: "normal" },
    { id: "version", label: labels.version, enabled: false, type: "normal" },
    { id: "separator", label: "", enabled: false, type: "separator" },
    { id: "quit", label: labels.quit, enabled: true, type: "normal" },
  ];
}

export interface ShortcutResult {
  /** Electron accelerator, or null for "no shortcut". */
  accelerator: string | null;
  error?: "not-shortcut";
}

const FUNCTION_KEYS = new Set(Array.from({ length: 20 }, (_, index) => `f${index + 1}`));

/**
 * myna's panelShortcut (panelkey.go): a modifier plus a letter, digit, Space
 * or F1–F20, written the way Electron's globalShortcut reads it. "Cmd" is
 * Command on a Mac and Super elsewhere, as myna maps it. "" is none.
 */
interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

function parseModifiers(parts: readonly string[]): Modifiers | null {
  const modifiers: Modifiers = { ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    switch (part.trim().toLowerCase()) {
      case "ctrl":
      case "control":
        modifiers.ctrl = true;
        break;
      case "alt":
      case "option":
        modifiers.alt = true;
        break;
      case "shift":
        modifiers.shift = true;
        break;
      case "cmd":
      case "command":
      case "super":
      case "win":
      case "meta":
        modifiers.meta = true;
        break;
      default:
        return null;
    }
  }
  return modifiers;
}

function normalizeKey(rawKey: string): { key: string; isFunctionKey: boolean } | null {
  if (rawKey.length === 1 && /^[a-z0-9]$/.test(rawKey)) {
    return { key: rawKey.toUpperCase(), isFunctionKey: false };
  }
  if (rawKey === "space") {
    return { key: "Space", isFunctionKey: false };
  }
  if (rawKey.length >= 2 && FUNCTION_KEYS.has(rawKey)) {
    return { key: rawKey.toUpperCase(), isFunctionKey: true };
  }
  return null;
}

export function normalizePanelShortcut(raw: string, platform: NodeJS.Platform): ShortcutResult {
  const input = raw.trim();
  if (input === "") {
    return { accelerator: null };
  }

  const parts = input.split("+");
  const modifiers = parseModifiers(parts.slice(0, -1));
  const normalizedKey = normalizeKey(parts[parts.length - 1]?.trim().toLowerCase() ?? "");
  if (modifiers === null || normalizedKey === null) {
    return { accelerator: null, error: "not-shortcut" };
  }
  const { ctrl, alt, shift, meta } = modifiers;
  const { key, isFunctionKey } = normalizedKey;

  // Shift alone would take a typing key everywhere; a function key may stand alone.
  if (!ctrl && !alt && !meta && !isFunctionKey) {
    return { accelerator: null, error: "not-shortcut" };
  }

  const acceleratorParts: string[] = [];
  if (ctrl) acceleratorParts.push("Control");
  if (alt) acceleratorParts.push("Alt");
  if (shift) acceleratorParts.push("Shift");
  if (meta) acceleratorParts.push(platform === "darwin" ? "Command" : "Super");

  return { accelerator: [...acceleratorParts, key].join("+") };
}

/**
 * The tray icon, from resources when packaged and assets in dev: a template glyph on macOS
 * (the app icon's white plate vanishes in a light menu bar), a full-colour tile elsewhere.
 * Electron loads the @2x file beside either one.
 */
export function resolveTrayIconPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  /** packages/desktop/assets in a dev checkout; callers resolve it from their own location. */
  assetsDir: string;
  platform: NodeJS.Platform;
}): string {
  const name = input.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const dir = input.isPackaged
    ? path.join(input.resourcesPath, "tray")
    : path.join(input.assetsDir, "tray");
  return path.join(dir, name);
}
