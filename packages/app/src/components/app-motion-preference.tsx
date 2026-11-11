import { ReduceMotion, ReducedMotionConfig } from "react-native-reanimated";
import { useAppSettings } from "@/hooks/use-settings";

/**
 * Applies the app's Reduce Motion switch to every reanimated animation, the
 * way the system's Reduce Motion does. Must sit in the tree once, above the
 * screens: reanimated reads the mode globally.
 */
export function AppMotionPreference() {
  const { settings } = useAppSettings();
  return (
    <ReducedMotionConfig mode={settings.reduceMotion ? ReduceMotion.Always : ReduceMotion.System} />
  );
}
