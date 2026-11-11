import { requireNativeView } from "expo";
import { useCallback, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import type {
  NeolixTerminalCellMetrics,
  NeolixTerminalFrame,
  NeolixTerminalTheme,
} from "./contract";
import { encodeTerminalCustomGlyphs, type NeolixTerminalCustomGlyph } from "./custom-glyphs";
import { encodeTerminalFrame, type NativeNeolixTerminalFrame } from "./frame-encoding";

export * from "./contract";

export interface NeolixTerminalViewProps {
  frame: NeolixTerminalFrame;
  theme: NeolixTerminalTheme;
  fontFamily: string;
  /** Font size in points after the system font scale is applied. */
  fontSize: number;
  onCellMetrics?: (metrics: NeolixTerminalCellMetrics) => void;
  style?: StyleProp<ViewStyle>;
}

interface NativeNeolixTerminalViewProps extends Omit<
  NeolixTerminalViewProps,
  "frame" | "onCellMetrics"
> {
  frame: NativeNeolixTerminalFrame;
  customGlyphs: NeolixTerminalCustomGlyph[];
  onCellMetrics?: (event: { nativeEvent: NeolixTerminalCellMetrics }) => void;
}

const NativeNeolixTerminalView = requireNativeView<NativeNeolixTerminalViewProps>("NeolixTerminal");
const CUSTOM_GLYPHS = encodeTerminalCustomGlyphs();

export function NeolixTerminalView({ frame, onCellMetrics, ...props }: NeolixTerminalViewProps) {
  const nativeFrame = useMemo(() => encodeTerminalFrame(frame), [frame]);
  const handleCellMetrics = useCallback(
    (event: { nativeEvent: NeolixTerminalCellMetrics }) => onCellMetrics?.(event.nativeEvent),
    [onCellMetrics],
  );
  return (
    <NativeNeolixTerminalView
      {...props}
      frame={nativeFrame}
      customGlyphs={CUSTOM_GLYPHS}
      onCellMetrics={handleCellMetrics}
    />
  );
}
