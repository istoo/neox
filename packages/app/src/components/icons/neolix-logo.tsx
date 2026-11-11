import Svg, { Circle, Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

// The Neox mark: the letter N drawn as a workflow graph. Same geometry as the desktop-web
// NeolixLogo (packages/desktop-web/apps/web/src/components/NeolixLogo.tsx).
const EDGES = "M27 75V25L73 75V25";
const NODES = [
  [27, 75],
  [27, 25],
  [73, 75],
  [73, 25],
] as const;

interface NeolixLogoProps {
  size?: number;
  color?: string;
}

export function NeolixLogo({ size = 64, color }: NeolixLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <Path d={EDGES} stroke={fill} strokeWidth={9} strokeLinejoin="round" />
      {NODES.map(([x, y]) => (
        <Circle key={`${x}-${y}`} cx={x} cy={y} r={11.5} fill={fill} />
      ))}
    </Svg>
  );
}
