import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { CalendarClock, Clock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { ExternalLink } from "@/components/ui/external-link";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { SchedulesTable, type ScheduleRowView } from "@/components/schedules/schedules-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import {
  useSchedules,
  type AggregateLoadState,
  type AggregatedSchedule,
  type ScheduleHostError,
} from "@/hooks/use-schedules";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  resolveSchedule,
  type ScheduleBucket,
  type ScheduleDerivedState,
  type ScheduleTargetAgent,
} from "@/schedules/schedule-derivation";
import {
  resolveSchedulesScreenBodyState,
  shouldRenderScheduleHostErrors,
} from "./schedules-screen-state";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
} from "@/schedules/schedule-project-targets";
import {
  scheduleFromKey,
  scheduleKey,
  SchedulesSidebar,
} from "@/components/sidebar/schedules-sidebar";
import { PageLayout } from "@/components/page-layout";
import { SettingsSection } from "@/components/settings";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import {
  canRunScheduleNow,
  canToggleSchedulePause,
  formatCadence,
  formatNextRun,
  resolveScheduleProductLabel,
  resolveScheduleTitle,
} from "@/utils/schedule-format";
import type { ScheduleSummary } from "@neolix/protocol/schedule/types";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; serverId: string; schedule: ScheduleSummary };

const STATUS_FILTER_OPTIONS: {
  value: ScheduleBucket;
  labelKey: "featurePages.schedules.active" | "featurePages.schedules.ended";
  testID: string;
}[] = [
  {
    value: "runnable",
    labelKey: "featurePages.schedules.active",
    testID: "schedules-filter-active",
  },
  { value: "ended", labelKey: "featurePages.schedules.ended", testID: "schedules-filter-ended" },
];

const EMPTY_SCHEDULES: AggregatedSchedule[] = [];

export function SchedulesScreen(): ReactElement {
  return <SchedulesScreenContent />;
}

function SchedulesScreenContent(): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const params = useLocalSearchParams<{ id?: string; new?: string }>();
  const { loadState, hostErrors, isError, refetch } = useSchedules();
  const schedules = loadState.status === "loaded" ? loadState.data : EMPTY_SCHEDULES;
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const { projects } = useProjects();
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );

  // Per-host agent-directory readiness from the runtime, not the aggregate agent
  // flag: the aggregate `isInitialLoad` flips false as soon as *any* host has
  // agents, so a still-loading host would falsely mark its agent-target
  // schedules "gone". `hasEverLoadedAgentDirectory` is true only once that
  // host's directory has loaded at least once.
  const agentDirReadyHosts = useMemo(() => {
    void runtimeVersion;
    const ready = new Set<string>();
    for (const host of hosts) {
      if (runtime.getSnapshot(host.serverId)?.hasEverLoadedAgentDirectory) {
        ready.add(host.serverId);
      }
    }
    return ready;
  }, [hosts, runtime, runtimeVersion]);

  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [statusFilter, setStatusFilter] = useState<ScheduleBucket>("runnable");

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  // The sidebar's New task row opens the form through the route.
  useEffect(() => {
    if (params.new === "1") {
      setForm({ mode: "create" });
    }
  }, [params.new]);

  const openCreate = useCallback(() => setForm({ mode: "create" }), []);
  const openEdit = useCallback((schedule: AggregatedSchedule) => {
    setForm({ mode: "edit", serverId: schedule.serverId, schedule });
  }, []);
  const closeForm = useCallback(() => {
    setForm({ mode: "closed" });
    if (params.new !== undefined) {
      router.setParams({ new: undefined });
    }
  }, [params.new]);

  const agentsByKey = useMemo(() => {
    const map = new Map<string, ScheduleTargetAgent>();
    for (const agent of agents) {
      map.set(`${agent.serverId}:${agent.id}`, { title: agent.title, provider: agent.provider });
    }
    return map;
  }, [agents]);

  const projectNameByCwd = useMemo(
    () => buildProjectNameByCwd(buildScheduleProjectTargets(projects)),
    [projects],
  );

  // Resolve every schedule's derived state and target line once, then partition
  // by the host and status filters. Sorted newest-first for a stable order
  // across hosts.
  const resolvedRows = useMemo(() => {
    const now = Date.now();
    return schedules.map((schedule) => ({
      schedule,
      resolved: resolveSchedule({
        schedule,
        serverId: schedule.serverId,
        now,
        agentsByKey,
        projectNameByCwd,
        agentDataLoaded: agentDirReadyHosts.has(schedule.serverId),
      }),
    }));
  }, [schedules, agentsByKey, projectNameByCwd, agentDirReadyHosts]);

  const visibleRows = useMemo<ScheduleRowView[]>(() => {
    const singleHost = hosts.length <= 1;
    return resolvedRows
      .filter(
        ({ schedule, resolved }) =>
          (selectedHost === ALL_HOSTS_OPTION_ID || schedule.serverId === selectedHost) &&
          resolved.bucket === statusFilter,
      )
      .sort((a, b) => Date.parse(b.schedule.createdAt) - Date.parse(a.schedule.createdAt))
      .map(({ schedule, resolved }) => ({
        schedule,
        targetLabel: resolved.target.label,
        provider: resolved.target.provider,
        state: resolved.state,
        serverName: schedule.serverName,
        singleHost,
      }));
  }, [resolvedRows, selectedHost, statusFilter, hosts.length]);

  const showLoadError = isError && loadState.status !== "loaded";
  const showHostFilter = hosts.length > 1;

  const selected = scheduleFromKey(schedules, params.id);
  const selectedResolved = useMemo(
    () => resolvedRows.find((row) => row.schedule === selected)?.resolved ?? null,
    [resolvedRows, selected],
  );

  const clearSelection = useCallback(() => {
    router.setParams({ id: undefined });
  }, []);
  const selectSchedule = useCallback((schedule: AggregatedSchedule) => {
    router.setParams({ id: scheduleKey(schedule), new: undefined });
  }, []);
  const detail = (
    <PageLayout
      title={selected ? resolveScheduleTitle(selected) : undefined}
      onBack={isCompact ? clearSelection : undefined}
      fill
      testID="schedules-detail"
    >
      <SchedulesDetailPane
        loadState={loadState}
        hostErrors={hostErrors}
        showLoadError={showLoadError}
        onRetry={refetch}
        onCreate={openCreate}
        onEdit={openEdit}
        schedule={selected}
        state={selectedResolved?.state ?? null}
        targetLabel={selectedResolved?.target.label ?? null}
      />
    </PageLayout>
  );

  let content: ReactElement;
  if (!isCompact) {
    content = (
      <View style={styles.split}>
        <SchedulesSidebar />
        {detail}
      </View>
    );
  } else if (selected) {
    content = detail;
  } else {
    content = (
      <View style={styles.container}>
        <MenuHeader title={t("featurePages.schedules.title")} />
        <SchedulesScreenBody
          rows={visibleRows}
          loadState={loadState}
          hostErrors={hostErrors}
          showLoadError={showLoadError}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          showHostFilter={showHostFilter}
          hosts={hosts}
          selectedHost={selectedHost}
          onSelectHost={setSelectedHost}
          onRetry={refetch}
          onCreate={openCreate}
          onEdit={openEdit}
          onSelectSchedule={selectSchedule}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {content}
      <ScheduleFormSheet
        serverId={form.mode === "edit" ? form.serverId : undefined}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        schedule={form.mode === "edit" ? form.schedule : undefined}
      />
    </View>
  );
}

/**
 * The wide-layout pane: one task, or the invitation ChatGPT's Scheduled tasks
 * page shows until one is picked. The list itself lives in the sidebar.
 */
function SchedulesDetailPane({
  loadState,
  hostErrors,
  showLoadError,
  onRetry,
  onCreate,
  onEdit,
  schedule,
  state,
  targetLabel,
}: {
  loadState: AggregateLoadState<AggregatedSchedule>;
  hostErrors: ScheduleHostError[];
  showLoadError: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (schedule: AggregatedSchedule) => void;
  schedule: AggregatedSchedule | null;
  state: ScheduleDerivedState | null;
  targetLabel: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const bodyState = resolveSchedulesScreenBodyState({ loadState, showLoadError });

  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("featurePages.schedules.loadFailed")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="schedules-retry">
          {t("featurePages.schedules.retry")}
        </Button>
      </View>
    );
  }

  if (bodyState.kind === "offline") {
    return <SchedulesOfflineState onRetry={onRetry} />;
  }

  const showHostErrors = shouldRenderScheduleHostErrors({ bodyState, hostErrors });

  return (
    <>
      {showHostErrors ? (
        <View style={styles.detailBanner}>
          <ScheduleHostErrorsBanner errors={hostErrors} />
        </View>
      ) : null}
      {schedule ? (
        <ScheduleDetail
          schedule={schedule}
          state={state}
          targetLabel={targetLabel}
          onEdit={onEdit}
        />
      ) : (
        <SchedulesInvitation onCreate={onCreate} />
      )}
    </>
  );
}

function SchedulesOfflineState({ onRetry }: { onRetry: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.centered}>
      <Text style={styles.message}>{t("featurePages.schedules.offline")}</Text>
      <Button variant="ghost" onPress={onRetry} testID="schedules-retry">
        {t("featurePages.schedules.retry")}
      </Button>
    </View>
  );
}

function SchedulesInvitation({ onCreate }: { onCreate: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.centered} testID="schedules-invitation">
      <Clock size={styles.invitationIcon.width} color={styles.invitationIcon.color} />
      <View style={styles.invitationText}>
        <Text style={styles.invitationTitle}>{t("featurePages.schedules.emptyList")}</Text>
        <Text style={styles.invitationDescription}>
          {t("featurePages.schedules.emptyDescription")}
        </Text>
      </View>
      <Button variant="default" onPress={onCreate} testID="schedules-invitation-new">
        {t("featurePages.schedules.emptyAction")}
      </Button>
    </View>
  );
}

function ScheduleDetail({
  schedule,
  state,
  targetLabel,
  onEdit,
}: {
  schedule: AggregatedSchedule;
  state: ScheduleDerivedState | null;
  targetLabel: string | null;
  onEdit: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useScheduleMutations({ serverId: schedule.serverId });
  const paused = schedule.status === "paused";
  const cadence = formatCadence(schedule.cadence);
  const nextRun = formatNextRun(schedule.nextRunAt);
  // 详情页头部与列表徽标共用同一份派生状态，已过期或目标丢失的任务不会显示为“进行中”。
  let statusLabel: string;
  switch (state) {
    case "expired":
      statusLabel = t("featurePages.schedules.statusExpired");
      break;
    case "finished":
      statusLabel = t("featurePages.schedules.statusCompleted");
      break;
    case "targetGone":
      statusLabel = t("featurePages.schedules.statusTargetGone");
      break;
    case "paused":
      statusLabel = t("featurePages.schedules.statusPaused");
      break;
    default: {
      if (schedule.status === "completed") {
        statusLabel = t("featurePages.schedules.statusCompleted");
      } else if (schedule.status === "paused") {
        statusLabel = t("featurePages.schedules.statusPaused");
      } else {
        statusLabel = t("featurePages.schedules.statusActive");
      }
    }
  }

  // daemon 会拒绝已完成任务的运行/暂停/恢复，因此直接隐藏控件，而不是等按下后报错。
  const canRunNow = state !== null && canRunScheduleNow(schedule, state);
  const showPauseToggle = state !== null && canToggleSchedulePause(state);

  const runNow = useCallback(() => {
    void (async () => {
      try {
        await mutations.runScheduleNow(schedule.id);
      } catch (error) {
        toast.error(t("featurePages.schedules.runFailed", { message: toErrorMessage(error) }));
      }
    })();
  }, [mutations, schedule.id, t, toast]);
  const togglePaused = useCallback(() => {
    void (async () => {
      try {
        await (paused
          ? mutations.resumeSchedule(schedule.id)
          : mutations.pauseSchedule(schedule.id));
      } catch (error) {
        toast.error(
          t(paused ? "featurePages.schedules.resumeFailed" : "featurePages.schedules.pauseFailed", {
            message: toErrorMessage(error),
          }),
        );
      }
    })();
  }, [mutations, paused, schedule.id, t, toast]);
  const edit = useCallback(() => onEdit(schedule), [onEdit, schedule]);
  const remove = useCallback(() => {
    void (async () => {
      try {
        const confirmed = await confirmDialog({
          title: t("featurePages.schedules.deleteConfirmTitle", {
            product: resolveScheduleProductLabel(schedule),
          }),
          message: t("featurePages.schedules.deleteConfirmMessage", {
            title: resolveScheduleTitle(schedule),
          }),
          confirmLabel: t("featurePages.schedules.delete"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        // 只有 daemon 确认删除成功后才清空路由；失败时清空会让任务从界面消失但仍留在主机上。
        await mutations.deleteSchedule(schedule.id);
        router.setParams({ id: undefined });
      } catch (error) {
        toast.error(t("featurePages.schedules.deleteFailed", { message: toErrorMessage(error) }));
      }
    })();
  }, [mutations, schedule, t, toast]);

  return (
    <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent}>
      <View style={styles.detailHeader}>
        <Text style={styles.detailStatus}>{statusLabel}</Text>
        <Text style={styles.detailMeta}>
          {cadence}
          {nextRun ? ` · ${t("featurePages.schedules.nextRun")} ${nextRun}` : ""}
        </Text>
      </View>

      <View style={styles.detailActions}>
        {canRunNow ? (
          <Button
            variant="outline"
            leftIcon={Play}
            onPress={runNow}
            disabled={mutations.isRunningNow}
            loading={mutations.isRunningNow}
          >
            {t("featurePages.schedules.runNow")}
          </Button>
        ) : null}
        {showPauseToggle ? (
          <Button
            variant="outline"
            leftIcon={paused ? Play : Pause}
            onPress={togglePaused}
            disabled={mutations.isPausing || mutations.isResuming}
            loading={mutations.isPausing || mutations.isResuming}
          >
            {paused ? t("featurePages.schedules.resume") : t("featurePages.schedules.pause")}
          </Button>
        ) : null}
        <Button variant="ghost" leftIcon={Pencil} onPress={edit}>
          {t("featurePages.schedules.edit")}
        </Button>
        <Button variant="ghost" leftIcon={Trash2} onPress={remove} disabled={mutations.isDeleting}>
          {t("featurePages.schedules.delete")}
        </Button>
      </View>

      <SettingsSection title={t("featurePages.schedules.prompt")}>
        <View style={settingsStyles.card}>
          <View style={styles.promptRow}>
            <Text selectable style={styles.promptText}>
              {schedule.prompt}
            </Text>
          </View>
        </View>
      </SettingsSection>

      <View style={settingsStyles.card}>
        <DetailField isFirst label={t("featurePages.schedules.cadence")} value={cadence} />
        <DetailField
          label={t("featurePages.schedules.nextRun")}
          value={nextRun || t("featurePages.schedules.never")}
        />
        <DetailField
          label={t("featurePages.schedules.target")}
          value={targetLabel ?? t("featurePages.schedules.unknownTarget")}
        />
        <DetailField label={t("featurePages.schedules.status")} value={statusLabel} />
        <DetailField label="ID" value={`${schedule.serverName} · ${schedule.id}`} />
      </View>
    </ScrollView>
  );
}

function DetailField({
  label,
  value,
  isFirst = false,
}: {
  label: string;
  value: string;
  isFirst?: boolean;
}): ReactElement {
  return (
    <View style={[settingsStyles.row, isFirst ? null : settingsStyles.rowBorder]}>
      <Text style={settingsStyles.rowTitle}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function SchedulesScreenBody({
  rows,
  loadState,
  hostErrors,
  showLoadError,
  statusFilter,
  onStatusFilterChange,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  onCreate,
  onEdit,
  onSelectSchedule,
}: {
  rows: ScheduleRowView[];
  loadState: AggregateLoadState<AggregatedSchedule>;
  hostErrors: ScheduleHostError[];
  showLoadError: boolean;
  statusFilter: ScheduleBucket;
  onStatusFilterChange: (value: ScheduleBucket) => void;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (schedule: AggregatedSchedule) => void;
  onSelectSchedule: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  const { t } = useTranslation();
  const bodyState = resolveSchedulesScreenBodyState({ loadState, showLoadError });
  const statusOptions = useMemo(
    () =>
      STATUS_FILTER_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
        testID: option.testID,
      })),
    [t],
  );

  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("featurePages.schedules.loadFailed")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="schedules-retry">
          {t("featurePages.schedules.retry")}
        </Button>
      </View>
    );
  }

  if (bodyState.kind === "offline") {
    return <SchedulesOfflineState onRetry={onRetry} />;
  }

  if (bodyState.kind === "empty") {
    return (
      <View style={styles.centered}>
        {hostErrors.length > 0 ? <ScheduleHostErrorsBanner errors={hostErrors} /> : null}
        <SchedulesEmptyState onCreate={onCreate} testID="schedules-empty" />
      </View>
    );
  }

  let schedulesContent: ReactElement;
  if (rows.length > 0) {
    schedulesContent = (
      <SchedulesTable rows={rows} onEditSchedule={onEdit} onSelectSchedule={onSelectSchedule} />
    );
  } else if (statusFilter === "ended") {
    schedulesContent = <SchedulesEndedEmptyState />;
  } else {
    schedulesContent = <SchedulesFilteredEmptyState />;
  }

  return (
    <View style={styles.body}>
      <View style={styles.filterRow}>
        <View style={styles.filterRowControls}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
              triggerTestID="schedules-host-filter-trigger"
            />
          ) : null}
          <SegmentedControl
            value={statusFilter}
            onValueChange={onStatusFilterChange}
            options={statusOptions}
            testID="schedules-status-filter"
          />
        </View>
        <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="schedules-new">
          {t("featurePages.schedules.newSchedule")}
        </Button>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="schedules-list"
      >
        {hostErrors.length > 0 ? <ScheduleHostErrorsBanner errors={hostErrors} /> : null}
        {schedulesContent}
      </ScrollView>
    </View>
  );
}

function SchedulesEmptyState({
  onCreate,
  testID,
}: {
  onCreate: () => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState} testID={testID}>
      <CalendarClock size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <View style={styles.emptyTextStack}>
        <Text style={styles.emptyTitle}>{t("featurePages.schedules.emptyList")}</Text>
        <Text style={styles.emptyDescription}>{t("featurePages.schedules.emptyDescription")}</Text>
        <ExternalLink
          href="https://github.com/istoo/neox/tree/main/public-docs/schedules.md"
          label={t("featurePages.schedules.seeDocs")}
        />
      </View>
      <Button variant="default" leftIcon={Plus} onPress={onCreate} testID="schedules-empty-new">
        {t("featurePages.schedules.emptyAction")}
      </Button>
    </View>
  );
}

/**
 * The active filter with tasks on the other side of it. Reached only once the
 * host returned schedules, so it never doubles as the zero-task state.
 */
function SchedulesFilteredEmptyState(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.filterEmpty}>
      <View style={styles.emptyTextStack}>
        <CalendarClock size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>{t("featurePages.schedules.emptyActiveTitle")}</Text>
        <Text style={styles.emptyDescription}>
          {t("featurePages.schedules.emptyActiveDescription")}
        </Text>
      </View>
    </View>
  );
}

function SchedulesEndedEmptyState(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.filterEmpty}>
      <View style={styles.endedEmptyState}>
        <CalendarClock size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>{t("featurePages.schedules.emptyEndedTitle")}</Text>
      </View>
    </View>
  );
}

function ScheduleHostErrorsBanner({ errors }: { errors: ScheduleHostError[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="schedules-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {t("featurePages.schedules.hostLoadFailed", { host: error.serverName })}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  split: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  filterRowControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
    flexWrap: "wrap",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  errorsBannerWrap: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  detailBanner: {
    paddingTop: theme.spacing[4],
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  filterEmpty: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  endedEmptyState: {
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyTextStack: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  invitationIcon: {
    color: theme.colors.foregroundMuted,
    width: 48,
  },
  invitationText: {
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 420,
  },
  invitationTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  invitationDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    textAlign: "center",
  },
  detailScroll: {
    flex: 1,
    minHeight: 0,
  },
  detailContent: {
    gap: theme.spacing[6],
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[12],
  },
  detailHeader: {
    gap: theme.spacing[2],
  },
  detailStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  promptRow: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  promptText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: 22,
  },
  detailValue: {
    flexShrink: 1,
    marginLeft: theme.spacing[4],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
}));
