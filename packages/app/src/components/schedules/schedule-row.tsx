import type { TFunction } from "i18next";
import { MoreVertical, Pause, Pencil, Play, RotateCw, Trash2 } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { useProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { ScheduleDerivedState } from "@/schedules/schedule-derivation";
import {
  formatCadence,
  formatNextRun,
  resolveScheduleMenuActions,
  resolveScheduleProductLabel,
  resolveScheduleTitle,
} from "@/utils/schedule-format";
import { useTimeAgo } from "@/hooks/use-time-ago";
import type { ScheduleSummary } from "@neolix/protocol/schedule/types";

// Themed lucide wrappers — module-scope so only the icon re-renders on theme
// change (never call useUnistyles in render). See docs/unistyles.md.
const ThemedPencil = withUnistyles(Pencil);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const MENU_ICON_SIZE = 14;
const PROVIDER_ICON_SIZE = 16;

// Pending flags for each action so the parent table can wire a mutation hook
// and the row reflects in-flight state without owning the mutation itself.
export interface ScheduleRowPending {
  pause?: boolean;
  resume?: boolean;
  runNow?: boolean;
  delete?: boolean;
}

export interface ScheduleRowActions {
  onEdit: () => void;
  /** Row press. Falls back to `onEdit` when the list has no detail pane. */
  onSelect?: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}

interface ScheduleRowProps extends ScheduleRowActions {
  serverId: string;
  schedule: ScheduleSummary;
  /** Client-derived target line (agent title / project / shortened path). */
  targetLabel: string;
  /** Provider glyph, resolved from the schedule config or the target agent. */
  provider: string | null;
  /** Client-derived state — the single source for the badge and next-run copy. */
  state: ScheduleDerivedState;
  /** Host name, rendered when the list spans more than one host. */
  serverName?: string;
  /** True when only one host exists and the host name would be redundant. */
  singleHost?: boolean;
  pending?: ScheduleRowPending;
  isFirst: boolean;
}

function stateBadge(
  t: TFunction,
  state: ScheduleDerivedState,
): {
  label: string;
  variant: "success" | "error" | "muted";
} {
  switch (state) {
    case "active":
      return { label: t("featurePages.schedules.statusActive"), variant: "success" };
    case "paused":
      return { label: t("featurePages.schedules.statusPaused"), variant: "muted" };
    case "expired":
      return { label: t("featurePages.schedules.statusExpired"), variant: "muted" };
    case "finished":
      return { label: t("featurePages.schedules.statusFinished"), variant: "muted" };
    case "targetGone":
      return { label: t("featurePages.schedules.statusTargetGone"), variant: "error" };
  }
}

// Meta reads left-to-right as identity → history → future: how often, when it
// was created, when it last ran, and (only while it can still run) when it runs
// next. Status lives on the badge, never repeated here.
function buildMeta(input: {
  t: TFunction;
  schedule: ScheduleSummary;
  state: ScheduleDerivedState;
  createdAgo: string;
  lastRunAgo: string;
  serverName: string | undefined;
  singleHost: boolean;
}): string {
  const { t, schedule, state, serverName, singleHost } = input;
  const parts = [
    formatCadence(schedule.cadence),
    t("featurePages.schedules.format.created", { time: input.createdAgo }),
    schedule.lastRunAt
      ? t("featurePages.schedules.format.lastRun", { time: input.lastRunAgo })
      : t("featurePages.schedules.format.neverRun"),
  ];
  if (state === "active") {
    const next = formatNextRun(schedule.nextRunAt);
    if (next) {
      parts.push(t("featurePages.schedules.format.nextRunAt", { time: next }));
    }
  }
  if (serverName && !singleHost) {
    parts.unshift(serverName);
  }
  return parts.join(" · ");
}

function ScheduleMeta({
  schedule,
  state,
  serverName,
  singleHost,
}: {
  schedule: ScheduleSummary;
  state: ScheduleDerivedState;
  serverName: string | undefined;
  singleHost: boolean;
}) {
  const { t } = useTranslation();
  const createdAgo = useTimeAgo(new Date(schedule.createdAt));
  const lastRunAgo = useTimeAgo(schedule.lastRunAt ? new Date(schedule.lastRunAt) : null);
  const meta = buildMeta({
    t,
    schedule,
    state,
    createdAgo,
    lastRunAgo,
    serverName,
    singleHost,
  });
  return (
    <Text style={settingsStyles.rowHint} numberOfLines={1}>
      {meta}
    </Text>
  );
}

/** Small provider glyph. Reads the icon color off a StyleSheet object so the
 * dynamic component (useProviderIcon) stays compliant without useUnistyles. */
function ProviderGlyph({
  provider,
  serverId,
}: {
  provider: string | null;
  serverId: string;
}): ReactElement | null {
  const Icon = useProviderIcon(provider ?? "", serverId);
  if (!provider) {
    return null;
  }
  return <Icon size={PROVIDER_ICON_SIZE} color={styles.providerIcon.color} />;
}

/**
 * One schedule, rendered as a settings-style card row: provider glyph + title,
 * a muted secondary line (model · cadence · next run), a StatusBadge, and the
 * kebab menu that owns every row action. Tapping the row opens the editor.
 *
 * Hover lives on the outer plain View (docs/hover.md): the inner Pressable owns
 * press, the nested kebab Pressable never fights it, and the row background
 * highlights without reflow.
 */
export function ScheduleRow({
  serverId,
  schedule,
  targetLabel,
  provider,
  state,
  serverName,
  singleHost,
  pending,
  isFirst,
  onEdit,
  onSelect,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const title = resolveScheduleTitle(schedule);
  const productLabel = resolveScheduleProductLabel(schedule);
  const badge = stateBadge(t, state);
  const menuActions = resolveScheduleMenuActions(schedule, state);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onSelect ?? onEdit}
        accessibilityRole="button"
        accessibilityLabel={
          onSelect
            ? title
            : `${t("featurePages.schedules.editProduct", {
                product: productLabel,
              })} ${title}`
        }
        testID={`schedule-row-${schedule.id}`}
      >
        <View style={styles.main}>
          <View style={styles.leading}>
            <ProviderGlyph provider={provider} serverId={serverId} />
          </View>
          <View style={styles.textGroup}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.target} numberOfLines={1}>
              {targetLabel}
            </Text>
            <ScheduleMeta
              schedule={schedule}
              state={state}
              serverName={serverName}
              singleHost={singleHost ?? false}
            />
          </View>
        </View>

        <View style={styles.trailing}>
          <StatusBadge label={badge.label} variant={badge.variant} />
          <ScheduleKebabMenu
            schedule={schedule}
            canRun={menuActions.runNow}
            canTogglePause={menuActions.togglePause}
            pending={pending}
            onEdit={onEdit}
            onPause={onPause}
            onResume={onResume}
            onRunNow={onRunNow}
            onDelete={onDelete}
          />
        </View>
      </Pressable>
    </View>
  );
}

const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const pauseLeading = <ThemedPause size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const resumeLeading = <ThemedPlay size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const runLeading = <ThemedRotateCw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash2 size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

function ScheduleExecutionMenuItems({
  t,
  schedule,
  canRun,
  canTogglePause,
  pending,
  onPause,
  onResume,
  onRunNow,
}: Pick<ScheduleRowProps, "schedule" | "pending" | "onPause" | "onResume" | "onRunNow"> & {
  t: TFunction;
  canRun: boolean;
  canTogglePause: boolean;
}): ReactElement {
  let cadenceAction: ReactElement;
  if (schedule.status === "paused") {
    cadenceAction = (
      <DropdownMenuItem
        leading={resumeLeading}
        disabled={!canTogglePause}
        status={pending?.resume ? "pending" : "idle"}
        pendingLabel={t("featurePages.schedules.resuming")}
        onSelect={onResume}
        testID={`schedule-menu-resume-${schedule.id}`}
      >
        {t("featurePages.schedules.resume")}
      </DropdownMenuItem>
    );
  } else {
    cadenceAction = (
      <DropdownMenuItem
        leading={pauseLeading}
        disabled={!canTogglePause}
        status={pending?.pause ? "pending" : "idle"}
        pendingLabel={t("featurePages.schedules.pausing")}
        onSelect={onPause}
        testID={`schedule-menu-pause-${schedule.id}`}
      >
        {t("featurePages.schedules.pause")}
      </DropdownMenuItem>
    );
  }

  return (
    <>
      {cadenceAction}
      {/* Heartbeats target an existing agent, so there is nothing for "Run now" to start. */}
      {schedule.target.type === "agent" ? null : (
        <DropdownMenuItem
          leading={runLeading}
          disabled={!canRun}
          status={pending?.runNow ? "pending" : "idle"}
          pendingLabel={t("featurePages.schedules.starting")}
          onSelect={onRunNow}
          testID={`schedule-menu-run-${schedule.id}`}
        >
          {t("featurePages.schedules.runNow")}
        </DropdownMenuItem>
      )}
    </>
  );
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function ScheduleKebabMenu({
  schedule,
  canRun,
  canTogglePause,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: Pick<
  ScheduleRowProps,
  "schedule" | "pending" | "onEdit" | "onPause" | "onResume" | "onRunNow" | "onDelete"
> & {
  canRun: boolean;
  canTogglePause: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const productLabel = resolveScheduleProductLabel(schedule);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("featurePages.schedules.actionsLabel", { product: productLabel })}
        testID={`schedule-kebab-${schedule.id}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          leading={editLeading}
          onSelect={onEdit}
          testID={`schedule-menu-edit-${schedule.id}`}
        >
          {t("featurePages.schedules.editProduct", { product: productLabel })}
        </DropdownMenuItem>
        <ScheduleExecutionMenuItems
          t={t}
          schedule={schedule}
          canRun={canRun}
          canTogglePause={canTogglePause}
          pending={pending}
          onPause={onPause}
          onResume={onResume}
          onRunNow={onRunNow}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          status={pending?.delete ? "pending" : "idle"}
          pendingLabel={t("featurePages.schedules.deleting")}
          onSelect={onDelete}
          testID={`schedule-menu-delete-${schedule.id}`}
        >
          {t("featurePages.schedules.deleteProduct", { product: productLabel })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the dynamic provider icon (compliant idiom).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  leading: {
    width: PROVIDER_ICON_SIZE,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  target: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
