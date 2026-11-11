/**
 * myna's panelShortcut format, checked here so the Settings row can say when
 * a combination is unusable (magpie/internal/gui/panelkey.go). The desktop
 * process normalizes it again before binding; keep the two in step
 * (packages/desktop/src/system/tray.ts).
 */
const FUNCTION_KEYS = new Set(Array.from({ length: 20 }, (_, index) => `f${index + 1}`));

export interface NormalizedShortcut {
  accelerator: string | null;
  valid: boolean;
}

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

export function normalizePanelShortcut(raw: string, platform: NodeJS.Platform): NormalizedShortcut {
  const input = raw.trim();
  if (input === "") {
    return { accelerator: null, valid: true };
  }

  const parts = input.split("+");
  const modifiers = parseModifiers(parts.slice(0, -1));
  const normalizedKey = normalizeKey(parts[parts.length - 1]?.trim().toLowerCase() ?? "");
  if (modifiers === null || normalizedKey === null) {
    return { accelerator: null, valid: false };
  }
  const { ctrl, alt, shift, meta } = modifiers;
  const { key, isFunctionKey } = normalizedKey;

  if (!ctrl && !alt && !meta && !isFunctionKey) {
    return { accelerator: null, valid: false };
  }

  const acceleratorParts: string[] = [];
  if (ctrl) acceleratorParts.push("Control");
  if (alt) acceleratorParts.push("Alt");
  if (shift) acceleratorParts.push("Shift");
  if (meta) acceleratorParts.push(platform === "darwin" ? "Command" : "Super");

  return { accelerator: [...acceleratorParts, key].join("+"), valid: true };
}
