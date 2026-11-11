import { router, usePathname } from "expo-router";
import { Bot, CalendarClock, Gauge, History, LibraryBig, Plus, Search } from "lucide-react-native";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { density } from "@/styles/density";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. New workspace is the one full-width outlined action above the
 * destination rows; every other item is a plain icon-and-label row in preference order.
 * Renders nothing — not even the wrapper — when every item is hidden.
 */
export function SidebarNavRows({ style, onBeforeNavigate, firstRowTrailing }: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const isNewWorkspace = useCallback(
    (item: (typeof visibleItems)[number]) => item.kind === "builtin" && item.id === "new-workspace",
    [],
  );
  const showsNewWorkspace = visibleItems.some(isNewWorkspace);
  const destinationItems = visibleItems.filter((item) => !isNewWorkspace(item));
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0) return null;

  const destinationRows = destinationItems.map((item) => {
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          onBeforeNavigate={onBeforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id as SidebarDestinationNavId];
    return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
  });

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {showsNewWorkspace || firstRowTrailing ? (
        <View style={styles.firstRow}>
          {showsNewWorkspace ? (
            <View style={styles.firstRowItem}>
              <SidebarNewWorkspaceButton onBeforeNavigate={onBeforeNavigate} />
            </View>
          ) : null}
          {firstRowTrailing}
        </View>
      ) : null}
      {destinationRows}
    </View>
  );
}

function useNewWorkspacePress(onBeforeNavigate?: () => void) {
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  return useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);
}

/**
 * The sidebar's one call to action: a full-width outlined button rather than another destination
 * row, because it creates something instead of navigating.
 */
const SidebarNewWorkspaceButton = memo(function SidebarNewWorkspaceButton({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const handlePress = useNewWorkspacePress(onBeforeNavigate);
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const shortcutHint = useMemo(
    () =>
      shortcutKeys ? (
        <View style={styles.shortcutHint}>
          <Shortcut chord={shortcutKeys} />
        </View>
      ) : null,
    [shortcutKeys],
  );
  const label = t(builtinSidebarNavLabelKey("new-workspace"));
  return (
    <Button
      variant="outline"
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={styles.newWorkspaceButton}
      leftIcon={Plus}
      trailing={isHovered ? shortcutHint : null}
      testID="sidebar-global-new-workspace"
      accessibilityLabel={label}
    >
      {label}
    </Button>
  );
});

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="nav"
      activeFill="selected"
    />
  );
}

function SidebarAgentsRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push("/agents");
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Bot}
      label={t(builtinSidebarNavLabelKey("agents"))}
      onPress={handlePress}
      isActive={pathname.startsWith("/agents")}
      testID="sidebar-agents"
      variant="nav"
      activeFill="selected"
    />
  );
}

function SidebarLibraryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push("/library");
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={LibraryBig}
      label={t(builtinSidebarNavLabelKey("library"))}
      onPress={handlePress}
      isActive={pathname.startsWith("/library")}
      testID="sidebar-library"
      variant="nav"
      activeFill="selected"
    />
  );
}

function SidebarModelsRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push("/models");
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Gauge}
      label={t(builtinSidebarNavLabelKey("models"))}
      onPress={handlePress}
      isActive={pathname.startsWith("/models") || pathname.startsWith("/myna")}
      testID="sidebar-models"
      variant="nav"
      activeFill="selected"
    />
  );
}

function SidebarSearchRow() {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    setCommandCenterOpen(true);
  }, [setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="nav"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="nav"
      activeFill="selected"
    />
  );
}

type SidebarDestinationNavId = Exclude<BuiltinSidebarNavId, "new-workspace">;

const BUILTIN_ROWS: Record<SidebarDestinationNavId, ComponentType<SidebarNavRowProps>> = {
  history: SidebarHistoryRow,
  agents: SidebarAgentsRow,
  library: SidebarLibraryRow,
  models: SidebarModelsRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};

const styles = StyleSheet.create((theme) => ({
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
  newWorkspaceButton: {
    width: "100%",
    justifyContent: "flex-start",
    minHeight: density.rowHeight,
    paddingHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    userSelect: "none",
  },
  shortcutHint: {
    marginLeft: "auto",
  },
}));
