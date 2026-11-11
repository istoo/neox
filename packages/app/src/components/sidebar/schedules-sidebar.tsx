import { router, useGlobalSearchParams } from "expo-router";
import { CalendarClock, ListFilter, Plus, Search } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FeatureSidebar } from "@/components/sidebar/feature-sidebar";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SearchField } from "@/components/ui/search-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSchedules, type AggregatedSchedule } from "@/hooks/use-schedules";
import {
  filterSchedulesForSidebar,
  formatCadence,
  resolveScheduleTitle,
  type ScheduleStatusFilter,
} from "@/utils/schedule-format";

export type StatusFilter = ScheduleStatusFilter;

/**
 * The Scheduled tasks column: the tasks themselves, the row that makes a new
 * one, and the page's own filter and search, in place of the workspace list the
 * way ChatGPT's sidebar does it.
 */
export function SchedulesSidebar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const params = useGlobalSearchParams<{ id?: string; filter?: string }>();
  const { loadState, isError } = useSchedules();
  const [filter, setFilter] = useState<StatusFilter>(
    params.filter === "ended" ? "ended" : "active",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const schedules = loadState.status === "loaded" ? loadState.data : EMPTY;
  const rows = useMemo(
    () => filterSchedulesForSidebar(schedules, filter, query),
    [schedules, filter, query],
  );

  const openNew = useCallback(() => {
    router.setParams({ new: "1", id: undefined });
  }, []);
  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      setQuery("");
      setSearchOpen(false);
      return;
    }
    setSearchOpen(true);
  }, [searchOpen]);
  const filterActive = useCallback(() => setFilter("active"), []);
  const filterEnded = useCallback(() => setFilter("ended"), []);

  let emptyMessage = t("featurePages.schedules.emptyFiltered");
  if (isError) {
    emptyMessage = t("featurePages.schedules.loadFailed");
  } else if (loadState.status === "offline") {
    emptyMessage = t("featurePages.schedules.offline");
  } else if (loadState.status !== "loaded") {
    emptyMessage = t("featurePages.schedules.loading");
  } else if (schedules.length === 0) {
    emptyMessage = t("featurePages.schedules.emptyList");
  } else if (query.trim().length > 0) {
    emptyMessage = t("featurePages.schedules.emptySearch");
  }

  return (
    <FeatureSidebar
      title={t("sidebar.sections.schedules")}
      testID="schedules-sidebar"
      compact={compact}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              accessibilityRole="button"
              accessibilityLabel={t("featurePages.schedules.filter")}
              style={styles.iconTrigger}
              testID="schedules-sidebar-filter"
            >
              <ListFilter size={16} color={styles.icon.color} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" width={200}>
              <DropdownMenuItem onSelect={filterActive}>
                {t("featurePages.schedules.active")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={filterEnded}>
                {t("featurePages.schedules.ended")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolbarButton
            label={t("sidebar.sections.search")}
            onPress={toggleSearch}
            testID="schedules-sidebar-search"
            style={styles.iconTrigger}
          >
            <Search size={16} color={styles.icon.color} />
          </ToolbarButton>
        </>
      }
    >
      {searchOpen ? (
        <View style={styles.searchWrap}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("featurePages.schedules.searchPlaceholder")}
            clearAccessibilityLabel={t("featurePages.schedules.clearSearch")}
            testID="schedules-sidebar-search-input"
            clearTestID="schedules-sidebar-search-clear"
          />
        </View>
      ) : null}
      {schedules.length > 0 ? (
        <SidebarHeaderRow
          icon={Plus}
          label={t("featurePages.schedules.newTask")}
          onPress={openNew}
          variant="compact"
          testID="schedules-sidebar-new"
        />
      ) : null}
      {rows.length === 0 ? (
        <Text style={styles.empty}>{emptyMessage}</Text>
      ) : (
        rows.map((schedule) => (
          <ScheduleSidebarRow
            key={`${schedule.serverId}:${schedule.id}`}
            schedule={schedule}
            selected={params.id === scheduleKey(schedule)}
          />
        ))
      )}
    </FeatureSidebar>
  );
}

function ScheduleSidebarRow({
  schedule,
  selected,
}: {
  schedule: AggregatedSchedule;
  selected: boolean;
}) {
  const open = useCallback(() => {
    router.setParams({ id: scheduleKey(schedule), new: undefined });
  }, [schedule]);
  const trailing = useMemo(
    () => (
      <Text numberOfLines={1} style={styles.cadence}>
        {schedule.status === "paused" ? undefined : formatCadence(schedule.cadence)}
      </Text>
    ),
    [schedule],
  );
  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={resolveScheduleTitle(schedule)}
      onPress={open}
      isActive={selected}
      activeFill="selected"
      variant="compact"
      trailing={trailing}
      testID={`schedules-sidebar-row-${schedule.serverId}-${schedule.id}`}
    />
  );
}

export function scheduleKey(schedule: { serverId: string; id: string }): string {
  return `${schedule.serverId}:${schedule.id}`;
}

export function scheduleFromKey(
  schedules: readonly AggregatedSchedule[],
  key: string | undefined,
): AggregatedSchedule | null {
  if (!key) {
    return null;
  }
  return schedules.find((schedule) => scheduleKey(schedule) === key) ?? null;
}

const EMPTY: AggregatedSchedule[] = [];

const styles = StyleSheet.create((theme) => ({
  searchWrap: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  iconTrigger: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  cadence: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // Static color holder for the lucide glyphs above.
  icon: {
    color: theme.colors.foregroundMuted,
  },
}));
