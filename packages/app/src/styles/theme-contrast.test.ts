import { describe, expect, it } from "vitest";
import {
  darkClaudeTheme,
  darkGhosttyTheme,
  darkMidnightTheme,
  darkPureBlackTheme,
  darkTheme,
  darkZincTheme,
  lightTheme,
  type Theme,
} from "./theme";

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

const DARK_THEMES: Array<[string, Theme]> = [
  ["dark", darkTheme],
  ["zinc", darkZincTheme],
  ["midnight", darkMidnightTheme],
  ["claude", darkClaudeTheme],
  ["ghostty", darkGhosttyTheme],
  ["pureBlack", darkPureBlackTheme],
];

// Surface4 is a decorative step (progress tracks, skeleton fills), not a text background. The
// light theme's selected sidebar row uses it directly, so the light set includes it; dark
// selected rows use `surfaceSidebarSelected` instead.
function textSurfaces(theme: Theme, includeSurface4: boolean) {
  return [
    theme.colors.surface0,
    theme.colors.surface1,
    theme.colors.surface2,
    theme.colors.surface3,
    theme.colors.surfaceSidebar,
    theme.colors.surfaceSidebarSelected,
    theme.colors.surfaceTabActive,
    ...(includeSurface4 ? [theme.colors.surface4] : []),
  ];
}

describe("text contrast floors", () => {
  it("keeps foreground and muted text at 4.5:1 on every light surface", () => {
    const surfaces = textSurfaces(lightTheme, true);
    for (const background of surfaces) {
      expect(contrastRatio(lightTheme.colors.foreground, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(lightTheme.colors.foregroundMuted, background)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("keeps extra-muted text at 4.5:1 in the light theme", () => {
    for (const background of textSurfaces(lightTheme, true)) {
      const extraMuted = contrastRatio(lightTheme.colors.foregroundExtraMuted, background);
      expect(extraMuted).toBeGreaterThanOrEqual(4.5);
      // The tier below muted must still read as a step down, not as the same ink.
      expect(extraMuted).toBeLessThan(contrastRatio(lightTheme.colors.foregroundMuted, background));
    }
  });

  for (const [name, theme] of DARK_THEMES) {
    it(`keeps foreground and muted text at 4.5:1 on every ${name} surface`, () => {
      for (const background of textSurfaces(theme, false)) {
        expect(contrastRatio(theme.colors.foreground, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.colors.foregroundMuted, background)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps extra-muted text at 4.5:1 in ${name}`, () => {
      for (const background of textSurfaces(theme, false)) {
        const extraMuted = contrastRatio(theme.colors.foregroundExtraMuted, background);
        expect(extraMuted).toBeGreaterThanOrEqual(4.5);
        // The tier below muted must still read as a step down, not as the same ink.
        expect(extraMuted).toBeLessThan(contrastRatio(theme.colors.foregroundMuted, background));
      }
    });
  }

  it("keeps the accent's label readable when the accent is used as a fill", () => {
    for (const [name, theme] of [["light", lightTheme], ...DARK_THEMES] as Array<[string, Theme]>) {
      expect(
        contrastRatio(theme.colors.accentForeground, theme.colors.accent),
        `${name} accent fill`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
