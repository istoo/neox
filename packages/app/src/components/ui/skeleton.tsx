import { useEffect, useMemo, useRef } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";
import { useAppSettings } from "@/hooks/use-settings";

/** One looping value per skeleton, shared by its shapes so they pulse together. */
export function useSkeletonPulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(0)).current;
  // myna's Loading bird: off, what is loading keeps still instead of hopping.
  const { settings } = useAppSettings();
  const animate = settings.loadingBird && !settings.reduceMotion;
  useEffect(() => {
    if (!animate) {
      pulse.setValue(0);
      return () => {};
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [animate, pulse]);
  return pulse;
}

/** A placeholder shape; `style` sets its size, radius and color. */
export function SkeletonPulse({
  pulse,
  style,
}: {
  pulse: Animated.Value;
  style: StyleProp<ViewStyle>;
}) {
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.8],
  });
  const pulseStyle = useMemo(() => [style, { opacity }], [style, opacity]);
  return <Animated.View style={pulseStyle} />;
}
