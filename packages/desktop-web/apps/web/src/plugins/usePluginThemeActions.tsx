// FILE: usePluginThemeActions.ts
// Purpose: Maps manifest theme contributions onto the app's chrome theme model and exposes them as
//          palette actions ("应用主题：X").
// Layer: Web plugin host
// Exports: pluginThemeToChromeTheme, usePluginThemeActions

import type { NeolixPluginTheme } from "@synara/contracts";
import { useMemo } from "react";

import type { SidebarSearchAction } from "~/components/SidebarSearchPalette.logic";
import { useTheme } from "~/hooks/useTheme";
import { useTranslation } from "~/i18n";
import type { ChromeTheme, ThemeVariant } from "~/theme/theme.logic";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex } from "./contributions";
import { PluginGlyph } from "./PluginGlyph";

/**
 * ChromeTheme has no dark/light switch of its own (the variant selects it), so a plugin theme maps
 * its semantic colors onto the five fields the shell derives everything else from.
 */
export function pluginThemeToChromeTheme(theme: NeolixPluginTheme): ChromeTheme {
  return {
    accent: theme.colors.accent ?? theme.colors.foreground,
    contrast: theme.appearance === "dark" ? 0.5 : -0.5,
    fonts: { ui: null, code: null },
    ink: theme.colors.foreground,
    opaqueWindows: true,
    semanticColors: {
      diffAdded: "#3fb950",
      diffRemoved: "#f85149",
      skill: theme.colors.accent ?? theme.colors.foreground,
    },
    surface: theme.colors.background,
  };
}

function ThemeGlyph({ className }: { className?: string }) {
  return <PluginGlyph name="sparkles" className={className} />;
}

export function usePluginThemeActions(): SidebarSearchAction[] {
  const plugins = useRunningPlugins();
  const { updateThemePack, setTheme } = useTheme();
  const { t } = useTranslation();
  return useMemo(
    () =>
      buildPluginContributionIndex(plugins).themes.map((entry) => ({
        id: `plugin-theme:${entry.pluginId}:${entry.contribution.id}`,
        label: t("common:pluginApplyTheme", { value0: entry.contribution.name }),
        description: entry.pluginName,
        keywords: ["theme", "主题", entry.contribution.name, entry.contribution.appearance],
        metaLabel: entry.pluginName,
        icon: ThemeGlyph,
        run: () => {
          const variant: ThemeVariant = entry.contribution.appearance;
          setTheme(variant);
          updateThemePack(variant, pluginThemeToChromeTheme(entry.contribution));
        },
      })),
    [plugins, setTheme, t, updateThemePack],
  );
}
