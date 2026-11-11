import { useCallback, useState, type ComponentType, type ReactNode, type Ref } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { density, densityIconBox } from "@/styles/density";
import type { ShortcutKey } from "@/utils/format-shortcut";

type SidebarHeaderRowVariant = "header" | "compact" | "nav" | "inline";

export type SidebarRowIcon = ComponentType<{ size: number; color: string }>;

interface SidebarHeaderRowProps {
  icon: SidebarRowIcon | null;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   * "nav": a compact row at standard list-row height with the larger glyph, for the app
   * sidebar's top-level navigation.
   * "inline": a full-width row with no inset, for a row inside a padded container such as the
   * sidebar footer.
   */
  variant?: SidebarHeaderRowVariant;
  /**
   * The selected row's fill. Feature pages show the sidebar's selected step;
   * every other sidebar keeps the shared hover step.
   */
  activeFill?: "hover" | "selected";
  /** Shown in the right slot while the row is hovered, when `trailing` is not set. */
  shortcutKeys?: ShortcutKey[][] | null;
  /**
   * The right slot. A sibling of the row's button, never inside it (web cannot nest buttons). A
   * press on the slot presses the row; a button inside it presses on its own.
   */
  trailing?: ReactNode;
  rowRef?: Ref<View>;
}

export function SidebarHeaderRow({
  icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  activeFill = "hover",
  shortcutKeys = null,
  trailing,
  rowRef,
}: SidebarHeaderRowProps) {
  // Two hover targets, because the main button and its trailing slot are siblings (web cannot
  // nest buttons). ORing them keeps the row lit while the pointer crosses from one to the other.
  const [isMainHovered, setIsMainHovered] = useState(false);
  const [isTrailingHovered, setIsTrailingHovered] = useState(false);
  const handleMainHoverIn = useCallback(() => setIsMainHovered(true), []);
  const handleMainHoverOut = useCallback(() => setIsMainHovered(false), []);
  const handleTrailingHoverIn = useCallback(() => setIsTrailingHovered(true), []);
  const handleTrailingHoverOut = useCallback(() => setIsTrailingHovered(false), []);
  const isHovered = isHeaderRowHovered(isMainHovered, isTrailingHovered);
  // The button and its trailing slot are siblings, so the row owns the pressed fill for both.
  const [isPressed, setIsPressed] = useState(false);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const isHighlighted = isHovered || isActive;
  const iconSize = iconSizeForVariant(variant);

  let right = trailing ?? null;
  if (right === null && shortcutKeys && isHovered) {
    right = <Shortcut chord={shortcutKeys} />;
  }

  return (
    <View ref={rowRef} collapsable={false} style={getContainerStyle(variant)}>
      <View style={resolveRowStyle({ variant, isActive, isHighlighted, isPressed, activeFill })}>
        <Pressable
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onHoverIn={handleMainHoverIn}
          onHoverOut={handleMainHoverOut}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={isActive ? SELECTED_STATE : undefined}
          aria-selected={isActive}
          style={resolveButtonStyle(variant)}
        >
          {icon ? (
            <DensityIcon
              icon={icon}
              size={iconSize}
              color={isHighlighted || variant === "nav" ? "foreground" : "foregroundMuted"}
            />
          ) : (
            <View style={variant === "header" ? styles.iconSpacer : styles.iconSpacerCompact} />
          )}
          <Text
            style={[
              styles.label,
              variant === "nav" && styles.labelNav,
              isHighlighted && styles.labelHighlighted,
            ]}
          >
            {label}
          </Text>
        </Pressable>
        {right === null ? null : (
          <Pressable
            onPress={onPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            onHoverIn={handleTrailingHoverIn}
            onHoverOut={handleTrailingHoverOut}
            accessible={false}
            focusable={false}
            style={styles.trailing}
          >
            {right}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const SELECTED_STATE = { selected: true } as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  containerNav: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  containerInline: {
    width: "100%",
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: density.tightRowHeight,
    borderRadius: theme.borderRadius.lg,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  // The app sidebar's top-level destinations read at list-row height; the header strip and the
  // feature-page sidebars keep the tighter compact row.
  rowNav: {
    minHeight: density.rowHeight,
  },
  // The workspace rows' pressed fill.
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
  },
  iconSpacer: { width: densityIconBox("md"), height: densityIconBox("md") },
  iconSpacerCompact: { width: densityIconBox("sm"), height: densityIconBox("sm") },
  buttonNav: {
    minHeight: density.rowHeight,
    paddingVertical: theme.spacing[1],
  },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  // Top-level destinations are primary navigation, not secondary chrome.
  labelNav: {
    color: theme.colors.foreground,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
}));

function getContainerStyle(variant: SidebarHeaderRowVariant) {
  switch (variant) {
    case "header":
      return styles.container;
    case "compact":
      return styles.containerCompact;
    case "nav":
      return styles.containerNav;
    case "inline":
      return styles.containerInline;
  }
}

function iconSizeForVariant(variant: SidebarHeaderRowVariant): "sm" | "md" {
  return variant === "nav" || variant === "header" ? "md" : "sm";
}

/**
 * A center row has two hover surfaces — its own button and the sibling trailing slot — because
 * the trailing control cannot live inside the button on web. Keeping the union means moving onto
 * the trailing slot (a shortcut hint, a count) does not drop the row's highlight.
 */
export function isHeaderRowHovered(mainHovered: boolean, trailingHovered: boolean): boolean {
  return mainHovered || trailingHovered;
}

function resolveRowStyle({
  variant,
  isActive,
  isHighlighted,
  isPressed,
  activeFill,
}: {
  variant: SidebarHeaderRowVariant;
  isActive: boolean;
  isHighlighted: boolean;
  isPressed: boolean;
  activeFill: "hover" | "selected";
}) {
  const isSelected = isActive && activeFill === "selected";
  return [
    styles.row,
    variant === "nav" && styles.rowNav,
    isHighlighted && !isSelected && styles.rowHighlighted,
    isSelected && styles.rowSelected,
    isPressed && styles.rowPressed,
  ];
}

function resolveButtonStyle(variant: SidebarHeaderRowVariant) {
  return variant === "nav" ? [styles.button, styles.buttonNav] : styles.button;
}
