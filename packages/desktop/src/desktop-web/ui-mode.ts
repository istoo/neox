import type { DesktopUiMode } from "../settings/desktop-settings.js";

/**
 * `NEOLIX_DESKTOP_UI` wins over the saved preference so a developer can try the
 * forked web renderer without writing state into the profile. Unknown values are
 * ignored rather than failing the launch.
 */
export function resolveDesktopUiMode(input: {
  envValue?: string | undefined;
  savedMode?: DesktopUiMode | undefined;
}): DesktopUiMode {
  switch (input.envValue?.trim().toLowerCase()) {
    case "web":
      return "web";
    case "native":
    case "rn":
      return "native";
    default:
      // An empty or unknown value is no pin; the web renderer is the default.
      return input.savedMode === "native" ? "native" : "web";
  }
}

/** True when the environment pins the renderer, so the menu cannot override it. */
export function isDesktopUiModeLockedByEnv(envValue: string | undefined): boolean {
  return (envValue?.trim().length ?? 0) > 0;
}

/**
 * What Settings shows for the renderer choice: the mode this launch resolved,
 * and whether the environment pin leaves the control usable.
 */
export function desktopUiModeState(input: {
  envValue?: string | undefined;
  savedMode?: DesktopUiMode | undefined;
}): { mode: DesktopUiMode; selectable: boolean } {
  return {
    mode: resolveDesktopUiMode(input),
    selectable: !isDesktopUiModeLockedByEnv(input.envValue),
  };
}

/** Renderer ids from IPC are untrusted; anything else means "do not switch". */
export function coerceDesktopUiMode(value: unknown): DesktopUiMode | null {
  return value === "web" || value === "native" ? value : null;
}
