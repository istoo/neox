import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * myna's fonts package (magpie/internal/fonts/fonts.go:31 Validate, :56
 * List): the installed faces a desktop page may choose, as names and CSS
 * traits — never files or paths. The appearance page's font field uses this
 * to offer a list instead of asking for a family name by hand.
 */
export type FontStyle = "normal" | "italic" | "oblique";

export interface SystemFontFace {
  family: string;
  name: string;
  weight: number;
  style: FontStyle;
  stretch: number;
}

export interface SystemFontFamily {
  name: string;
  styles: SystemFontFace[];
}

export type FontCommandRunner = (file: string, args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultRunner: FontCommandRunner = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
};

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** myna's Validate: a usable name and trait set, or the face is dropped. */
export function isValidFace(face: SystemFontFace): boolean {
  for (const value of [face.family, face.name]) {
    if (value.trim() === "" || value.length > 512 || hasControlCharacters(value)) {
      return false;
    }
  }
  if (!Number.isFinite(face.weight) || face.weight < 1 || face.weight > 1000) {
    return false;
  }
  if (face.style !== "normal" && face.style !== "italic" && face.style !== "oblique") {
    return false;
  }
  if (!Number.isFinite(face.stretch) || face.stretch < 0) {
    return false;
  }
  return true;
}

function styleRank(style: FontStyle): number {
  if (style === "normal") return 0;
  return style === "italic" ? 1 : 2;
}

/** myna's group(): trimmed, de-duplicated, and sorted for the menu. */
export function groupFaces(faces: readonly SystemFontFace[]): SystemFontFamily[] {
  const byFamily = new Map<string, SystemFontFace[]>();
  const seen = new Set<string>();
  for (const raw of faces) {
    const face: SystemFontFace = {
      ...raw,
      family: raw.family.trim(),
      name: raw.name.trim(),
    };
    if (!isValidFace(face)) {
      continue;
    }
    const key = `${face.family}\u0000${face.name}\u0000${face.weight}\u0000${face.style}\u0000${face.stretch}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
  }

  const families: SystemFontFamily[] = [];
  for (const [name, styles] of byFamily) {
    styles.sort(
      (a, b) =>
        a.weight - b.weight ||
        styleRank(a.style) - styleRank(b.style) ||
        a.stretch - b.stretch ||
        a.name.localeCompare(b.name),
    );
    families.push({ name, styles });
  }
  families.sort(
    (a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name),
  );
  return families;
}

function slantStyle(value: number): FontStyle {
  if (value === 100) return "italic";
  if (value === 110) return "oblique";
  return "normal";
}

/** `fc-list --format '%{family}\t%{style}\t%{weight}\t%{slant}\t%{width}\n'`. */
export function parseFcList(output: string): SystemFontFace[] {
  const faces: SystemFontFace[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const [families = "", name = "", weight = "400", slant = "0", stretch = "100"] =
      line.split("\t");
    const parsedWeight = Number.parseInt(weight, 10);
    const parsedSlant = Number.parseInt(slant, 10);
    const parsedStretch = Number.parseFloat(stretch);
    for (const family of families.split(",")) {
      faces.push({
        family: family.trim(),
        name: name.trim(),
        weight: Number.isFinite(parsedWeight) ? parsedWeight : 400,
        style: slantStyle(parsedSlant),
        stretch: Number.isFinite(parsedStretch) ? parsedStretch : 100,
      });
    }
  }
  return faces;
}

interface MacSystemProfiler {
  SPFontsDataType?: Array<{
    typefaces?: Array<{
      family?: string;
      style?: string;
      fullname?: string;
      _name?: string;
    }>;
  }>;
}

/** `system_profiler SPFontsDataType -json`; style names are localized, so only family and slant are read. */
export function parseMacSystemProfiler(output: string): SystemFontFace[] {
  const faces: SystemFontFace[] = [];
  let document: MacSystemProfiler;
  try {
    document = JSON.parse(output) as MacSystemProfiler;
  } catch {
    return faces;
  }
  for (const font of document.SPFontsDataType ?? []) {
    for (const face of font.typefaces ?? []) {
      const family = face.family?.trim();
      if (!family) {
        continue;
      }
      const label = `${face.style ?? ""} ${face.fullname ?? ""} ${face._name ?? ""}`.toLowerCase();
      const style: FontStyle = /italic|oblique|斜体|курсив|イタリック|기울임/.test(label)
        ? "italic"
        : "normal";
      const bold = /bold|黑体|полужирн|ボールド|굵게/.test(label);
      faces.push({
        family,
        name: (face.style ?? face.fullname ?? face._name ?? "Regular").trim(),
        weight: bold ? 700 : 400,
        style,
        stretch: 100,
      });
    }
  }
  return faces;
}

/** Windows' installed families, one per line; styles need DirectWrite, which Node lacks. */
export function parseWindowsFontList(output: string): SystemFontFace[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((family) => ({
      family,
      name: "Regular",
      weight: 400,
      style: "normal" as const,
      stretch: 100,
    }));
}

export interface ListSystemFontsOptions {
  platform?: NodeJS.Platform;
  run?: FontCommandRunner;
}

let cached: SystemFontFamily[] | null = null;

/** Reads the system's collection; a successful read is cached until refresh. */
export async function listSystemFonts(
  options: ListSystemFontsOptions & { refresh?: boolean } = {},
): Promise<SystemFontFamily[]> {
  if (cached && options.refresh !== true) {
    return cached;
  }
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  let faces: SystemFontFace[];
  if (platform === "darwin") {
    faces = parseMacSystemProfiler(await run("system_profiler", ["SPFontsDataType", "-json"]));
  } else if (platform === "linux") {
    faces = parseFcList(
      await run("fc-list", ["--format=%{family}\t%{style}\t%{weight}\t%{slant}\t%{width}\n"]),
    );
  } else if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Drawing; " +
      "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
      "ForEach-Object { $_.Name }";
    faces = parseWindowsFontList(
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]),
    );
  } else {
    return [];
  }
  const families = groupFaces(faces);
  cached = families;
  return families;
}

/** Test seam: forget the cached collection. */
export function resetFontCacheForTests(): void {
  cached = null;
}
