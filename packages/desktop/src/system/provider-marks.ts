import { existsSync } from "node:fs";
import path from "node:path";
import { app, nativeImage } from "electron";

/**
 * The provider marks the Mac menu bar draws in a card (myna's trayCell.Icon).
 * Neolix's provider marks in the app are SVGs, and nativeImage cannot read
 * SVG, so the marks that ship as 16pt-ready PNGs live here. `claude` and
 * `codex` were rendered from packages/app/assets/icons; another provider's
 * mark is a PNG in this folder under its gateway provider id.
 *
 * A card without a mark here keeps its provider name in the text, as myna
 * does with trayCell.Letter when a logo cannot be read.
 */
const PROVIDER_MARKS = new Set(["claude", "codex"]);

function providerMarkPath(provider: string): string | null {
  if (!PROVIDER_MARKS.has(provider)) {
    return null;
  }
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "provider-logos", `${provider}.png`)]
    : [path.join(__dirname, "..", "..", "assets", "provider-logos", `${provider}.png`)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function hasProviderMark(provider: string): boolean {
  return providerMarkPath(provider) !== null;
}

/**
 * The mark as a 16pt template image. Template images are recoloured by the
 * menu bar, which is what myna's Mono glyphs do.
 */
export function providerMarkDataUrl(provider: string): string | null {
  const file = providerMarkPath(provider);
  if (file === null) {
    return null;
  }
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    return null;
  }
  return image.resize({ width: 16, height: 16 }).toDataURL();
}
