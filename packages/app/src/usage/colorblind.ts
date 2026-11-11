import { useColorScheme } from "react-native";
import { useAppSettings } from "@/hooks/use-settings";

/**
 * The success/warning/danger palette usage surfaces read when Colorblind mode
 * is on. Okabe–Ito's hues stay distinguishable under every common form of
 * color vision deficiency; the level is picked to sit on the app's light or
 * dark surface.
 */
export interface UsageToneColors {
  success: string;
  warning: string;
  danger: string;
}

// Okabe–Ito: blue for OK, orange for warning, vermillion for danger.
const LIGHT_TONE_COLORS: UsageToneColors = {
  success: "#0072B2",
  warning: "#E69F00",
  danger: "#D55E00",
};

// On dark surfaces the blue steps up to sky blue; the warm pair stays.
const DARK_TONE_COLORS: UsageToneColors = {
  success: "#56B4E9",
  warning: "#F0E442",
  danger: "#D55E00",
};

/** Only "light" is a light built-in theme; "auto" and plugin themes follow the system. */
function isDarkAppearance(theme: string, systemScheme: string | null): boolean {
  if (theme === "light") {
    return false;
  }
  if (theme === "auto" || theme === "plugin") {
    return systemScheme === "dark";
  }
  return true;
}

/** Null when the mode is off, so callers keep their theme's status colors. */
export function useColorblindUsageColors(): UsageToneColors | null {
  const { settings } = useAppSettings();
  const systemScheme = useColorScheme();
  if (!settings.colorblindMode) {
    return null;
  }
  return isDarkAppearance(settings.theme, systemScheme) ? DARK_TONE_COLORS : LIGHT_TONE_COLORS;
}
