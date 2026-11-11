import { describe, expect, it } from "vitest";
import {
  darkClaudeTheme,
  darkGhosttyTheme,
  darkMidnightTheme,
  darkPureBlackTheme,
  darkTheme,
  darkZincTheme,
  FONT_SIZE,
  getNextThemePreference,
  lightTheme,
  THEME_OPTIONS,
} from "./theme";

describe("Typography scale", () => {
  it("names 14px as the default interface tier", () => {
    expect(FONT_SIZE).toEqual({
      code: 12,
      content: 15,
      sm: 12,
      base: 14,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    });
  });
});

describe("Theme catalog", () => {
  it("owns the picker and shortcut order", () => {
    expect(THEME_OPTIONS.map((option) => option.name)).toEqual([
      "light",
      "dark",
      "auto",
      "zinc",
      "midnight",
      "claude",
      "ghostty",
      "pureBlack",
    ]);
    expect(getNextThemePreference("dark")).toBe("auto");
    expect(getNextThemePreference("pureBlack")).toBe("light");
  });
});

describe("Pure black theme", () => {
  it("uses a pure black application and terminal background", () => {
    expect(darkPureBlackTheme.colors.surface0).toBe("#000000");
    expect(darkPureBlackTheme.colors.background).toBe("#000000");
    expect(darkPureBlackTheme.colors.terminal.background).toBe("#000000");
  });

  it("uses Neolix's muted green accent", () => {
    expect(darkPureBlackTheme.colors.accent).toBe("#20744A");
    expect(darkPureBlackTheme.colors.accentBright).toBe("#7ccba0");
  });

  it("derives sidebar interaction surfaces from the surface scale", () => {
    expect(darkPureBlackTheme.colors.surfaceSidebar).toBe("#000000");
    expect(darkPureBlackTheme.colors.surfaceSidebarHover).toBe(darkPureBlackTheme.colors.surface1);
    expect(darkPureBlackTheme.colors.surfaceSidebarSelected).toBe(
      darkPureBlackTheme.colors.surface2,
    );
  });

  it("keeps ANSI black output readable on its zero-luminance terminal background", () => {
    expect(darkPureBlackTheme.colors.terminal.black).toBe("#595959");
    expect(darkPureBlackTheme.colors.terminal.brightBlack).toBe("#8a8a8a");
  });
});

describe("Sidebar interaction surfaces", () => {
  // Synara's selection is an ink step, not an accent tint: the accent is kept for links, focus
  // and the one primary affordance.
  it("keeps Light hover and selection as neutral ink steps over the sidebar", () => {
    expect(lightTheme.colors.surfaceSidebar).toBe("#f7f7f7");
    expect(lightTheme.colors.surfaceSidebarHover).toBe("#f0f0f0");
    expect(lightTheme.colors.surfaceTabActive).toBe(lightTheme.colors.surface3);
    expect(lightTheme.colors.surfaceSidebarSelected).toBe("#ececec");
    expect(lightTheme.colors.surfaceSidebarSelected).not.toBe(lightTheme.colors.surfaceSidebar);
  });

  it("keeps Dark hover and selection as neutral ink steps over the sidebar", () => {
    expect(darkTheme.colors.surfaceSidebar).toBe("#151515");
    expect(darkTheme.colors.surfaceSidebarHover).toBe("#1e1e1e");
    expect(darkTheme.colors.surfaceSidebarSelected).toBe("#1b1b1b");
    expect(darkTheme.colors.surfaceTabActive).toBe(darkTheme.colors.surface2);
  });

  it("leaves each named dark variant its own accent and surface hue", () => {
    expect(darkZincTheme.colors.accent).toBe("#e4e4e7");
    expect(darkZincTheme.colors.surface0).toBe("#18181b");
    expect(darkMidnightTheme.colors.accent).toBe("#3b6fcf");
    expect(darkMidnightTheme.colors.surface0).toBe("#161820");
    expect(darkClaudeTheme.colors.accent).toBe("#d97757");
    expect(darkClaudeTheme.colors.surface0).toBe("#1f1f1e");
    expect(darkGhosttyTheme.colors.accent).toBe("#3570e0");
    expect(darkGhosttyTheme.colors.surface0).toBe("#282c34");
  });
});

describe("Built-in light theme", () => {
  it("preserves its authored aliases and terminal contrast through the semantic builder", () => {
    expect(lightTheme.colors).toMatchObject({
      primary: "#0d0d0d",
      primaryForeground: "#ffffff",
      destructiveForeground: "#ffffff",
      successForeground: "#ffffff",
      terminal: {
        black: "#0d0d0d",
        brightBlack: "#6e6e6e",
      },
    });
  });
});
