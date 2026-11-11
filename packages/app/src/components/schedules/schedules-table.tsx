import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScheduleRow, type ScheduleRowPending } from "@/components/schedules/schedule-row";
import { useToast } from "@/contexts/toast-context";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import type { AggregatedSchedule } from "@/hooks/use-schedules";
import type { ScheduleDerivedState } from "@/schedules/schedule-derivation";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { resolveScheduleProductLabel, resolveScheduleTitle } from "@/utils/schedule-format";

/** A schedule plus the client-derived fields the row renders. */
export interface ScheduleRowView {
  schedule: AggregatedSchedule;
  targetLabel: string;
  provider: string | null;
  state: ScheduleDerivedState;
  serverName: string;
  /** True when only one host exists, so the host name is redundant in rows. */
  singleHost: boolean;
}

interface SchedulesTableProps {
  rows: ScheduleRowView[];
  /**
   * The form sheet is owned by the screen (it serves both create and edit and
   * shares the screen's "New schedule" button), so the table delegates edit
   * upward rather than mounting a second sheet here.
   */
  onEditSchedule: (schedule: AggregatedSchedule) => void;
  /** Compact list: open the task's detail instead of its edit form. */
  onSelectSchedule?: (schedule: AggregatedSchedule) => void;
}

/**
 * The schedules list: a single settings-style card of rows across every
 * connected host, in a full-width list matching the History screen. Rows own
 * their host-scoped mutations (pause/resume/run/delete via the mutations hook +
 * a destructive confirm) and delegate editing upward.
 */
export function SchedulesTable({
  rows,
  onEditSchedule,
  onSelectSchedule,
}: SchedulesTableProps): ReactElement {
  return (
    <View style={styles.listContent} testID="schedules-table">
      <View style={settingsStyles.card}>
        {rows.map((row, index) => (
          <SchedulesTableRow
            key={`${row.schedule.serverId}:${row.schedule.id}`}
            row={row}
            isFirst={index === 0}
            onEditSchedule={onEditSchedule}
            {...(onSelectSchedule === undefined ? {} : { onSelectSchedule })}
          />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-row wrapper owns local in-flight state and binds mutations to this
// schedule's host. Local state keeps pending precise to the acting row even
// when several rows are acted on at once (the mutations hook exposes only a
// single global pending flag per action).
// ---------------------------------------------------------------------------

const NO_PENDING: ScheduleRowPending = {};

function SchedulesTableRow({
  row,
  isFirst,
  onEditSchedule,
  onSelectSchedule,
}: {
  row: ScheduleRowView;
  isFirst: boolean;
  onEditSchedule: (schedule: AggregatedSchedule) => void;
  onSelectSchedule?: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { schedule } = row;
  const { id, serverId } = schedule;
  const mutations = useScheduleMutations({ serverId });
  const [pending, setPending] = useState<ScheduleRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (
      key: keyof ScheduleRowPending,
      failureKey: "runFailed" | "pauseFailed" | "resumeFailed" | "deleteFailed",
      action: () => Promise<void>,
    ): Promise<void> => {
      setPending((current) => ({ ...current, [key]: true }));
      try {
        await action();
      } catch (error) {
        // mutation 会自行回滚乐观缓存；这里用 toast 告诉用户这一行为何恢复原状。
        toast.error(t(`featurePages.schedules.${failureKey}`, { message: toErrorMessage(error) }));
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [t, toast],
  );

  const handleEdit = useCallback(() => {
    onEditSchedule(schedule);
  }, [onEditSchedule, schedule]);

  const handleSelect = useCallback(() => {
    if (onSelectSchedule) {
      onSelectSchedule(schedule);
      return;
    }
    onEditSchedule(schedule);
  }, [onEditSchedule, onSelectSchedule, schedule]);

  const handlePause = useCallback(() => {
    void runAction("pause", "pauseFailed", () => mutations.pauseSchedule(id));
  }, [runAction, mutations, id]);

  const handleResume = useCallback(() => {
    void runAction("resume", "resumeFailed", () => mutations.resumeSchedule(id));
  }, [runAction, mutations, id]);

  const handleRunNow = useCallback(() => {
    void runAction("runNow", "runFailed", () => mutations.runScheduleNow(id));
  }, [runAction, mutations, id]);

  const handleDelete = useCallback(() => {
    void (async () => {
      try {
        const productLabel = resolveScheduleProductLabel(schedule);
        const confirmed = await confirmDialog({
          title: t("featurePages.schedules.deleteConfirmTitle", { product: productLabel }),
          message: t("featurePages.schedules.deleteConfirmMessage", {
            title: resolveScheduleTitle(schedule),
          }),
          confirmLabel: t("featurePages.schedules.delete"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        await runAction("delete", "deleteFailed", () => mutations.deleteSchedule(id));
      } catch (error) {
        toast.error(t("featurePages.schedules.deleteFailed", { message: toErrorMessage(error) }));
      }
    })();
  }, [runAction, mutations, id, schedule, t, toast]);

  return (
    <ScheduleRow
      serverId={row.schedule.serverId}
      schedule={schedule}
      targetLabel={row.targetLabel}
      provider={row.provider}
      state={row.state}
      serverName={row.serverName}
      singleHost={row.singleHost}
      isFirst={isFirst}
      pending={pending}
      onEdit={handleEdit}
      onSelect={handleSelect}
      onPause={handlePause}
      onResume={handleResume}
      onRunNow={handleRunNow}
      onDelete={handleDelete}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Full-width list padding matching the History screen.
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
}));
