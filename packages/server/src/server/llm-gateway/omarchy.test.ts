import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  currentOmarchyTheme,
  detectOmarchy,
  omarchyThemeDir,
  omarchyVars,
  parseOmarchyColor,
  parseOmarchyToml,
  resetOmarchyCacheForTests,
} from "./omarchy.js";

let root = "";

function write(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

const COLORS = [
  'mode = "dark"',
  'background = "#1a1b26"',
  'foreground = "#c0caf5"',
  'accent = "#7aa2f7"',
  'red = "#f7768e"',
  'green = "#9ece6a"',
  'yellow = "#e0af68"',
  "",
].join("\n");

const SHELL = [
  "[popups]",
  'background = "#1a1b26"',
  'text = "#c0caf5"',
  'border = "hyprland.active-border"',
  "[controls]",
  "normal-fill-alpha = 0.04",
  "[font]",
  "base-size = 13",
  "",
].join("\n");

describe("omarchy", () => {
  beforeEach(() => {
    resetOmarchyCacheForTests();
    root = mkdtempSync(path.join(tmpdir(), "neolix-omarchy-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("parses the little TOML the theme files use", () => {
    expect(parseOmarchyToml(SHELL)).toMatchObject({
      "popups.background": "#1a1b26",
      "popups.border": "hyprland.active-border",
      "controls.normal-fill-alpha": "0.04",
      "font.base-size": "13",
    });
    expect(parseOmarchyToml('name = "x" # comment\nflag = true')).toEqual({
      name: "x",
      flag: "true",
    });
  });

  it("reads every colour form myna reads", () => {
    expect(parseOmarchyColor("#abc")).toEqual({
      r: 0xaa / 255,
      g: 0xbb / 255,
      b: 0xcc / 255,
      a: 1,
    });
    expect(parseOmarchyColor("rgb(ff0000)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseOmarchyColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseOmarchyColor("rgba(000000ff) rgba(ffffff) 45deg")).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    });
    expect(parseOmarchyColor("nonsense")).toBeNull();
  });

  it("turns a palette into Neox's CSS custom properties", () => {
    const { vars, mode } = omarchyVars(
      parseOmarchyToml(COLORS),
      parseOmarchyToml(SHELL),
      "CaskaydiaMono Nerd Font",
      8,
      2,
    );
    expect(mode).toBe("dark");
    expect(vars["--bg"]).toBe("#1a1b26");
    expect(vars["--fg"]).toBe("#c0caf5");
    expect(vars["--accent"]).toBe("#7aa2f7");
    expect(vars["--om-radius"]).toBe("8px");
    expect(vars["--om-border"]).toBe("2px");
    expect(vars["--om-size"]).toBe("13px");
    expect(vars["--font"]).toContain("CaskaydiaMono Nerd Font");
    expect(vars["--om-edge"]).toBe(vars["--accent"]);
    expect(vars["--logo-invert"]).toBe("1");
  });

  it("finds the current theme and keeps the desktop defaults when nothing answers", async () => {
    const state = path.join(root, "state");
    const dir = path.join(state, "omarchy", "current", "theme");
    write(path.join(dir, "colors.toml"), COLORS);
    write(path.join(dir, "shell.toml"), SHELL);
    write(path.join(state, "omarchy", "current", "theme.name"), "tokyo-night\n");

    const env = { XDG_STATE_HOME: state } as NodeJS.ProcessEnv;
    expect(await omarchyThemeDir({ env, homeDir: root })).toBe(dir);
    expect(await detectOmarchy({ env: { ...env, NEOLIX_OMARCHY: "0" }, homeDir: root })).toBe(
      false,
    );

    const theme = await currentOmarchyTheme({
      env: { ...env, NEOLIX_OMARCHY: "1" },
      homeDir: root,
      run: async (file) => (file === "omarchy-font-current" ? "CaskaydiaMono\n" : ""),
    });
    expect(theme).not.toBeNull();
    expect(theme?.name).toBe("tokyo-night");
    expect(theme?.mode).toBe("dark");
    expect(theme?.vars["--om-radius"]).toBe("0px");
    expect(theme?.vars["--om-border"]).toBe("2px");
    expect(theme?.stamp).not.toBe("");
  });

  it("answers null off Omarchy", async () => {
    const theme = await currentOmarchyTheme({
      env: { NEOLIX_OMARCHY: "0" } as NodeJS.ProcessEnv,
      homeDir: root,
    });
    expect(theme).toBeNull();
  });
});
