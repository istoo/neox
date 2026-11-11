import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * myna's omarchy package (magpie/internal/omarchy/omarchy.go:33 Detect,
 * :375 Current): whether Neolix runs on Omarchy, the Hyprland desktop, and
 * the look its current theme gives every surface. Omarchy keeps the theme
 * under ~/.local/state/omarchy/current/theme — colors.toml (the palette)
 * and shell.toml (the shell's own tokens) — with the font from
 * omarchy-font-current and the corners and border from Hyprland.
 *
 * The daemon serves this at GET /v1/myna/omarchy; a client elsewhere gets
 * null and keeps its own theme.
 */
export interface OmarchyTheme {
  name: string;
  mode: "dark" | "light";
  /** Changes when anything the look is made of does. */
  stamp: string;
  vars: Record<string, string>;
}

export interface OmarchyOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Runs a command and returns stdout; injectable so tests never call hyprctl. */
  run?: (file: string, args: readonly string[]) => Promise<string>;
}

const execFileAsync = promisify(execFile);

const defaultRun = async (file: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync(file, [...args], { timeout: 2_000 });
  return stdout;
};

function homeOf(options: OmarchyOptions): string {
  return options.homeDir ?? os.homedir();
}

function stateHome(options: OmarchyOptions): string {
  const env = options.env ?? process.env;
  return env.XDG_STATE_HOME?.trim() || path.join(homeOf(options), ".local", "state");
}

/** The current theme's folder, or "" when there is none. */
export async function omarchyThemeDir(options: OmarchyOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const forced = env.NEOLIX_OMARCHY_THEME ?? env.MYNA_OMARCHY_THEME;
  if (forced) {
    return forced;
  }
  const candidates = [
    path.join(stateHome(options), "omarchy", "current", "theme"),
    path.join(homeOf(options), ".config", "omarchy", "current", "theme"), // before 4.0
  ];
  for (const dir of candidates) {
    try {
      if ((await fs.stat(path.join(dir, "colors.toml"))).isFile()) {
        return dir;
      }
    } catch {
      // Try the next one.
    }
  }
  return "";
}

/** Whether this machine runs Omarchy. */
export async function detectOmarchy(options: OmarchyOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const forced = env.NEOLIX_OMARCHY ?? env.MYNA_OMARCHY;
  if (forced === "1") {
    return true;
  }
  if (forced === "0") {
    return false;
  }
  if (
    (options.platform ?? process.platform) !== "linux" ||
    (await omarchyThemeDir(options)) === ""
  ) {
    return false;
  }
  if ((env.OMARCHY_PATH ?? "").trim() !== "") {
    return true;
  }
  for (const dir of [
    "/usr/share/omarchy",
    path.join(homeOf(options), ".local", "share", "omarchy"),
  ]) {
    try {
      if ((await fs.stat(dir)).isDirectory()) {
        return true;
      }
    } catch {
      // Not this one.
    }
  }
  return false;
}

/**
 * The little of TOML the theme files use: key = value, strings, numbers,
 * booleans and comments, a section's keys as "section.key".
 */
export function parseOmarchyToml(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      section = line.replace(/^\[+|\]+$/g, "").trim();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) {
      continue;
    }
    let key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      if (end >= 0) {
        value = value.slice(1, end);
      }
    } else {
      const comment = value.indexOf("#");
      if (comment >= 0) {
        value = value.slice(0, comment).trim();
      }
    }
    if (section !== "") {
      key = `${section}.${key}`;
    }
    values[key] = value;
  }
  return values;
}

export interface OmarchyColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** #rgb, #rrggbb, #rrggbbaa, rgb(rrggbb), rgba(rrggbbaa), rgb(r, g, b), a gradient's first colour. */
export function parseOmarchyColor(input: string): OmarchyColor | null {
  let value = input.trim().toLowerCase();
  const fields = value.split(/\s+/);
  if (fields.length > 1 && !value.includes(",")) {
    value = fields[0] ?? "";
  }

  const hex = (text: string): OmarchyColor | null => {
    let digits = text;
    if (digits.length === 3) {
      digits = [...digits].map((digit) => `${digit}${digit}`).join("");
    }
    if (digits.length !== 6 && digits.length !== 8) {
      return null;
    }
    if (!/^[0-9a-f]+$/.test(digits)) {
      return null;
    }
    const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6), 16) : 0xff;
    return {
      r: Number.parseInt(digits.slice(0, 2), 16) / 255,
      g: Number.parseInt(digits.slice(2, 4), 16) / 255,
      b: Number.parseInt(digits.slice(4, 6), 16) / 255,
      a: alpha / 255,
    };
  };

  if (value.startsWith("#")) {
    return hex(value.slice(1));
  }
  if (value.startsWith("rgb")) {
    const open = value.indexOf("(");
    const close = value.lastIndexOf(")");
    if (open < 0 || close < open) {
      return null;
    }
    const inner = value.slice(open + 1, close).trim();
    if (!inner.includes(",")) {
      return hex(inner);
    }
    const parts = inner.split(",");
    if (parts.length < 3) {
      return null;
    }
    const channels = [0, 0, 0, 1];
    parts.slice(0, 4).forEach((part, index) => {
      const parsed = Number.parseFloat(part.trim());
      if (!Number.isFinite(parsed)) {
        return;
      }
      channels[index] = index < 3 ? parsed / 255 : parsed;
    });
    return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0, a: channels[3] ?? 1 };
  }
  return null;
}

function cssColor(color: OmarchyColor): string {
  const to = (value: number): number => Math.round(Math.max(0, Math.min(255, value * 255)));
  if (color.a >= 0.999) {
    return `#${[to(color.r), to(color.g), to(color.b)]
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const alpha = Math.max(0, Math.min(1, color.a)).toFixed(3);
  return `rgba(${to(color.r)}, ${to(color.g)}, ${to(color.b)}, ${alpha})`;
}

function over(foreground: OmarchyColor, background: OmarchyColor, alpha: number): OmarchyColor {
  return {
    r: background.r + (foreground.r - background.r) * alpha,
    g: background.g + (foreground.g - background.g) * alpha,
    b: background.b + (foreground.b - background.b) * alpha,
    a: 1,
  };
}

function withAlpha(color: OmarchyColor, alpha: number): OmarchyColor {
  return { ...color, a: alpha };
}

function luminance(color: OmarchyColor): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/** The palette and shell tokens as Neolix's CSS custom properties, and the mode. */
export function omarchyVars(
  colors: Record<string, string>,
  shell: Record<string, string>,
  font: string,
  rounding: number,
  border: number,
): { vars: Record<string, string>; mode: "dark" | "light" } {
  const get = (
    values: Record<string, string>,
    fallback: OmarchyColor,
    ...keys: string[]
  ): OmarchyColor => {
    for (const key of keys) {
      let value = values[key];
      // A shell token may name another: "hyprland.active-border".
      for (let hop = 0; hop < 3 && value !== undefined; hop += 1) {
        const next = shell[value];
        if (next === undefined) break;
        value = next;
      }
      const parsed = value === undefined ? null : parseOmarchyColor(value);
      if (parsed) {
        return parsed;
      }
    }
    return fallback;
  };
  const num = (key: string, fallback: number): number => {
    const parsed = Number.parseFloat(shell[key] ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const black: OmarchyColor = { r: 0, g: 0, b: 0, a: 1 };
  const baseBg = get(colors, { r: 0.102, g: 0.106, b: 0.149, a: 1 }, "background");
  const bg = { ...get(shell, baseBg, "popups.background"), a: 1 };
  const fg = get(
    shell,
    get(colors, { r: 0.663, g: 0.694, b: 0.839, a: 1 }, "foreground"),
    "popups.text",
  );
  let mode: "dark" | "light";
  if (colors.mode === "light" || colors.mode === "dark") {
    mode = colors.mode;
  } else {
    mode = luminance(bg) > 0.5 ? "light" : "dark";
  }

  let dim = get(colors, over(fg, bg, 0.55), "dark_foreground");
  if (mode === "light") {
    dim = get(colors, over(fg, bg, 0.6), "muted", "dark_foreground");
  }
  const accent = get(
    shell,
    get(colors, { r: 0.478, g: 0.635, b: 0.969, a: 1 }, "accent", "blue"),
    "menu.selected-text",
  );
  const bright = get(colors, fg, "bright_foreground");
  const red = get(colors, { r: 0.969, g: 0.463, b: 0.557, a: 1 }, "red");
  const green = get(colors, { r: 0.62, g: 0.808, b: 0.416, a: 1 }, "green");
  const yellow = get(colors, { r: 0.878, g: 0.686, b: 0.408, a: 1 }, "yellow");
  const orange = get(colors, yellow, "orange");
  const cyan = get(colors, { r: 0.267, g: 0.616, b: 0.671, a: 1 }, "cyan");
  const blue = get(colors, accent, "blue");
  const magenta = get(colors, { r: 0.678, g: 0.557, b: 0.902, a: 1 }, "magenta");

  const edge = get(shell, accent, "popups.border", "hyprland.active-border");
  const selFg = get(shell, fg, "menu.selected-background");
  const selA = num("menu.selected-background-alpha", 0.08);
  const fillA = num("controls.normal-fill-alpha", 0.04);
  const hoverA = num("controls.hover-cursor-fill-alpha", 0.08);
  const ctlBorderA = num("controls.normal-border-alpha", 0.4);
  const pressA = num("controls.pressed-fill-alpha", 0.22);
  const selectedA = num("controls.selected-fill-alpha", 0.18);
  const size = num("font.base-size", 12);
  const soft = (color: OmarchyColor): string => cssColor(over(color, bg, 0.16));
  const shadow = withAlpha(black, mode === "light" ? 0.12 : 0.35);
  const invert = mode === "light" ? "0" : "1";
  const familyName = font === "" ? "JetBrainsMono Nerd Font" : font;
  const family = `"${familyName}", "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace`;

  const vars: Record<string, string> = {
    "--bg": cssColor(bg),
    "--card": cssColor(over(fg, bg, fillA)),
    "--card-2": cssColor(over(fg, bg, fillA / 2)),
    "--pill": cssColor(over(fg, bg, fillA)),
    "--pill-hover": cssColor(over(fg, bg, hoverA)),
    "--pill-line": cssColor(withAlpha(fg, ctlBorderA)),
    "--pill-shadow": "none",
    "--card-edge": "none",
    "--seg-track": "transparent",
    "--seg-thumb": cssColor(over(fg, bg, selectedA)),
    "--seg-edge": "none",
    "--line": cssColor(over(fg, bg, 0.16)),
    "--line-2": cssColor(over(fg, bg, 0.1)),
    "--fg": cssColor(fg),
    "--fg-2": cssColor(fg),
    "--fg-hi": cssColor(bright),
    "--muted": cssColor(dim),
    "--faint": cssColor(over(fg, bg, 0.38)),
    "--accent": cssColor(accent),
    "--accent-soft": cssColor(over(accent, bg, 0.14)),
    "--accent-fg": cssColor(bg),
    "--sel": cssColor(over(selFg, bg, selA)),
    "--press": cssColor(over(fg, bg, pressA)),
    "--green": cssColor(green),
    "--green-soft": soft(green),
    "--red": cssColor(red),
    "--red-soft": soft(red),
    "--amber": cssColor(yellow),
    "--amber-soft": soft(yellow),
    "--drift": cssColor(red),
    "--drift-soft": soft(red),
    "--pop-bg": cssColor(bg),
    "--shadow": `0 8px 24px ${cssColor(shadow)}`,
    "--skel": cssColor(over(fg, bg, 0.06)),
    "--skel-hi": cssColor(over(fg, bg, 0.12)),
    "--font": family,
    "--code": family,
    "--logo-invert": invert,
    "--tk-s": cssColor(green),
    "--tk-k": cssColor(magenta),
    "--tk-f": cssColor(blue),
    "--tk-n": cssColor(orange),
    "--tk-v": cssColor(cyan),
    "--tk-o": cssColor(magenta),
    "--tk-c": cssColor(dim),
    "--om-edge": cssColor(edge),
    "--om-border": `${Math.max(border, 1)}px`,
    "--om-radius": `${Math.max(rounding, 0)}px`,
    "--om-size": `${size}px`,
    "--om-hover": cssColor(withAlpha(fg, hoverA)),
    "--om-hover-line": cssColor(withAlpha(fg, num("controls.hover-cursor-border-alpha", 0.25))),
    "--om-sel": cssColor(withAlpha(selFg, selA)),
    "--om-sel-line": cssColor(
      withAlpha(get(shell, fg, "menu.selected-border"), num("menu.selected-border-alpha", 0.25)),
    ),
    "--om-cyan": cssColor(cyan),
    "--om-magenta": cssColor(magenta),
    "--om-orange": cssColor(orange),
  };
  return { vars, mode };
}

function themeFiles(dir: string): string[] {
  return [
    path.join(dir, "colors.toml"),
    path.join(dir, "shell.toml"),
    path.join(path.dirname(dir), "theme.name"),
  ];
}

function desktopFiles(options: OmarchyOptions): string[] {
  const env = options.env ?? process.env;
  const config = env.XDG_CONFIG_HOME?.trim() || path.join(homeOf(options), ".config");
  return [path.join(config, "fontconfig", "fonts.conf"), path.join(config, "hypr")];
}

async function stampOf(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      parts.push(`${path.basename(file)}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      // A file that isn't there contributes nothing, as in myna.
    }
  }
  return parts.join(";");
}

function fnv(text: string): string {
  let hash = 14695981039346656037n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16);
}

async function fontName(run: OmarchyOptions["run"]): Promise<string> {
  try {
    return (await (run ?? defaultRun)("omarchy-font-current", [])).trim();
  } catch {
    return "";
  }
}

async function hyprInt(option: string, fallback: number, options: OmarchyOptions): Promise<number> {
  if (!(options.env ?? process.env).HYPRLAND_INSTANCE_SIGNATURE) {
    return fallback;
  }
  try {
    const output = await (options.run ?? defaultRun)("hyprctl", ["getoption", option]);
    for (const line of output.split("\n")) {
      const match = /^\s*int:\s*(-?\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        return Number.parseInt(match[1], 10);
      }
    }
  } catch {
    // Hyprland doesn't answer; the fallback stands.
  }
  return fallback;
}

interface CacheEntry {
  askedAt: number;
  themeStamp: string;
  deskStamp: string;
  font: string;
  rounding: number;
  border: number;
  theme: OmarchyTheme | null;
}

let cache: CacheEntry | null = null;

/** The theme as it is now; read again only when one of its files changed. */
export async function currentOmarchyTheme(
  options: OmarchyOptions = {},
): Promise<OmarchyTheme | null> {
  if (!(await detectOmarchy(options))) {
    return null;
  }
  const dir = await omarchyThemeDir(options);
  if (dir === "") {
    return null;
  }
  const now = Date.now();
  if (cache && now - cache.askedAt < 1_000) {
    return cache.theme;
  }
  const themeStamp = await stampOf(themeFiles(dir));
  const deskStamp = await stampOf(desktopFiles(options));
  if (cache && cache.themeStamp === themeStamp && cache.deskStamp === deskStamp) {
    cache.askedAt = now;
    return cache.theme;
  }

  const font = await fontName(options.run);
  const rounding = await hyprInt("decoration:rounding", 0, options);
  const border = await hyprInt("general:border_size", 2, options);
  const [colorsText, shellText, nameText] = await Promise.all([
    fs.readFile(path.join(dir, "colors.toml"), "utf8").catch(() => ""),
    fs.readFile(path.join(dir, "shell.toml"), "utf8").catch(() => ""),
    fs.readFile(path.join(path.dirname(dir), "theme.name"), "utf8").catch(() => ""),
  ]);
  const { vars, mode } = omarchyVars(
    parseOmarchyToml(colorsText),
    parseOmarchyToml(shellText),
    font,
    rounding,
    border,
  );
  const theme: OmarchyTheme = {
    name: nameText.trim(),
    mode,
    stamp: fnv(`${themeStamp}${deskStamp}${font}${rounding}${border}`),
    vars,
  };
  cache = { askedAt: now, themeStamp, deskStamp, font, rounding, border, theme };
  return theme;
}

/** Test seam: forget the cached theme. */
export function resetOmarchyCacheForTests(): void {
  cache = null;
}
