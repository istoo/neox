import { useReducedMotion } from "react-native-reanimated";
import { useAppSettings } from "@/hooks/use-settings";

/**
 * Reduce Motion the way the app should see it: the system preference, or the
 * app's own switch on top of it (myna's "Reduce motion"). Components that
 * branch on motion read this instead of reanimated's hook so the switch has
 * an effect even where the OS setting is off.
 */
export function useAppReducedMotion(): boolean {
  const systemReducedMotion = useReducedMotion();
  const { settings } = useAppSettings();
  return systemReducedMotion || settings.reduceMotion;
}
