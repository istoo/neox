import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { RoutingTone } from "./routing-model";

/**
 * A routing step or seat's state, through the one status-dot mapping rather
 * than a local set of coloured dots.
 */
const TONE_PROPS = {
  neutral: (theme: Theme) => ({
    color: getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }),
  }),
  active: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "running" }) }),
  ok: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "attention" }) }),
  danger: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "failed" }) }),
  muted: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "needs_input" }) }),
} satisfies Record<RoutingTone, (theme: Theme) => { color: string | null }>;

function RoutingDotView({ color, style }: { color: string | null; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.dot, style, color === null ? null : { backgroundColor: color }]} />;
}

const ThemedRoutingDot = withUnistyles(RoutingDotView);

export function RoutingDot({ tone, style }: { tone: RoutingTone; style?: StyleProp<ViewStyle> }) {
  return <ThemedRoutingDot uniProps={TONE_PROPS[tone]} style={style} />;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
}));
