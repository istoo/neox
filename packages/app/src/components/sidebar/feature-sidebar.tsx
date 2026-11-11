import type { ReactElement, ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { FEATURE_DESKTOP_SIDEBAR_WIDTH } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/** The navigation hint a feature section row carries on compact layouts. */
export function FeatureSidebarChevron(): ReactElement {
  return <ThemedChevronRight size={ICON_SIZE.sm} />;
}

/**
 * The list column of a feature page: a title, the page's own actions beside it,
 * and rows underneath. It sits inside the content area beside the detail pane
 * on wide layouts, and becomes the full screen list on compact ones.
 */
export function FeatureSidebar({
  title,
  actions,
  headerAccessory,
  children,
  testID,
  compact = false,
}: {
  title: string;
  /** Icon buttons on the title row, to its right. */
  actions?: ReactNode;
  /**
   * A full-width control under the title, such as a host filter. It gets its own
   * row so a wide control cannot squeeze the title, and sits on the same left
   * and right rails as the section rows.
   */
  headerAccessory?: ReactNode;
  children: ReactNode;
  testID?: string;
  /** Compact list screen: a menu header instead of the desktop column. */
  compact?: boolean;
}) {
  const body = (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
  if (compact) {
    return (
      <View style={styles.compactContainer} testID={testID}>
        <MenuHeader title={title} rightContent={actions} />
        {headerAccessory ? <View style={styles.headerAccessory}>{headerAccessory}</View> : null}
        {body}
      </View>
    );
  }
  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.header}>
        <ScreenTitle numberOfLines={1} style={styles.title}>
          {title}
        </ScreenTitle>
        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </View>
      {headerAccessory ? <View style={styles.headerAccessory}>{headerAccessory}</View> : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: FEATURE_DESKTOP_SIDEBAR_WIDTH,
    flexShrink: 1,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    // The app sidebar owns the sidebar surface. This second column is part of
    // the content pane, so it reads on the main surface with a hairline seam.
    backgroundColor: theme.colors.surface0,
  },
  compactContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  title: {
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
  },
  // The section rows' highlight spans the scroll content inset, so the
  // accessory shares those rails instead of the title row's tighter inset.
  headerAccessory: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
}));
