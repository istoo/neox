import path from "node:path";

import type { DesktopAppIconName } from "../settings/desktop-settings.js";

/**
 * Where an Appearance › App icon variant lives: `resources/app-icons` once packaged
 * (electron-builder extraResources), `assets/app-icons` in a dev checkout. `default` has no
 * file of its own: it is the bundle icon (or the dev-stamped icon), which the caller owns.
 */
export function resolveChosenAppIconPath(input: {
  name: DesktopAppIconName;
  isPackaged: boolean;
  resourcesPath: string;
  assetsDir: string;
  exists: (candidate: string) => boolean;
}): string | null {
  if (input.name === "default") return null;
  const dir = input.isPackaged
    ? path.join(input.resourcesPath, "app-icons")
    : path.join(input.assetsDir, "app-icons");
  const candidate = path.join(dir, `${input.name}.png`);
  return input.exists(candidate) ? candidate : null;
}
