import { router, useGlobalSearchParams } from "expo-router";
import {
  BookOpen,
  Bot,
  Search,
  Server,
  Sparkles,
  SquareTerminal,
  Webhook,
  type LucideIcon,
} from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FeatureSidebar, FeatureSidebarChevron } from "@/components/sidebar/feature-sidebar";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useLibrary } from "@/hooks/use-library";
import { useActiveHostServerId } from "@/hooks/use-active-host-server-id";
import {
  LIBRARY_VIEWS,
  libraryViewCounts,
  type LibraryView,
} from "@/screens/settings/library/library-page";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

const VIEW_ICONS: Record<LibraryView, LucideIcon> = {
  instructions: BookOpen,
  mcp: Server,
  skills: Sparkles,
  hooks: Webhook,
  subagents: Bot,
  rtk: SquareTerminal,
};

/**
 * The library's own column: instructions, MCP servers, skills and the rest as
 * rows with their counts, in place of the workspace list. The page content
 * follows the row that is on.
 */
export function LibrarySidebar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const params = useGlobalSearchParams<{ view?: string }>();
  const serverId = useActiveHostServerId();
  const { library } = useLibrary(serverId ?? "");
  const counts = useMemo(() => libraryViewCounts(library), [library]);
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const openSearch = useCallback(() => setCommandCenterOpen(true), [setCommandCenterOpen]);
  const actions = useMemo(
    () => (
      <ToolbarButton
        label={t("sidebar.sections.search")}
        onPress={openSearch}
        testID="library-sidebar-search"
        style={styles.iconTrigger}
      >
        <Search size={16} color={styles.icon.color} />
      </ToolbarButton>
    ),
    [openSearch, t],
  );

  return (
    <FeatureSidebar
      title={t("sidebar.sections.library")}
      testID="library-sidebar"
      actions={actions}
      compact={compact}
    >
      {LIBRARY_VIEWS.map((view) => (
        <LibrarySidebarRow
          key={view}
          view={view}
          selected={!compact && (params.view ?? "instructions") === view}
          count={counts[view]}
          compact={compact}
        />
      ))}
    </FeatureSidebar>
  );
}

function LibrarySidebarRow({
  view,
  selected,
  count,
  compact,
}: {
  view: LibraryView;
  selected: boolean;
  count: number | undefined;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    router.setParams({ view });
  }, [view]);
  const trailing = useMemo(() => {
    const countLabel =
      count !== undefined && count > 0 ? <Text style={styles.count}>{count}</Text> : null;
    if (!compact) {
      return countLabel;
    }
    return (
      <>
        {countLabel}
        <FeatureSidebarChevron />
      </>
    );
  }, [compact, count]);
  return (
    <SidebarHeaderRow
      icon={VIEW_ICONS[view]}
      label={t(`settings.usePages.library.tabs.${view}`)}
      onPress={open}
      isActive={selected}
      activeFill="selected"
      variant="compact"
      trailing={trailing}
      testID={`library-sidebar-${view}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  iconTrigger: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // Static color holder for the lucide glyphs above.
  icon: {
    color: theme.colors.foregroundMuted,
  },
}));
