import type { ScheduleCadence, ScheduleSummary } from "@neolix/protocol/schedule/types";
import { validateCronExpression } from "@neolix/protocol/schedule/cron-expression";
import { i18n } from "@/i18n/i18next";

export type IntervalUnit = "minutes" | "hours" | "days";
type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = MS_PER_MINUTE * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: MS_PER_MINUTE,
  hours: MS_PER_HOUR,
  days: MS_PER_DAY,
};

const DAY_LABEL_KEYS = [
  "weekdaySunday",
  "weekdayMonday",
  "weekdayTuesday",
  "weekdayWednesday",
  "weekdayThursday",
  "weekdayFriday",
  "weekdaySaturday",
] as const;

export function isNewAgentSchedule(schedule: ScheduleSummary): boolean {
  return schedule.target.type === "new-agent";
}

export function scheduleProductName(schedule: ScheduleSummary): "Heartbeat" | "Schedule" {
  return schedule.target.type === "agent" ? "Heartbeat" : "Schedule";
}

/** 面向用户的产品名，用于菜单与确认框文案。 */
export function resolveScheduleProductLabel(schedule: ScheduleSummary): string {
  return schedule.target.type === "agent"
    ? i18n.t("featurePages.schedules.productHeartbeat")
    : i18n.t("featurePages.schedules.productSchedule");
}

export function resolveScheduleTitle(schedule: ScheduleSummary): string {
  const name = schedule.name?.trim();
  if (name) {
    return name;
  }
  if (schedule.target.type === "new-agent") {
    const configTitle = schedule.target.config.title?.trim();
    if (configTitle) {
      return configTitle;
    }
  }
  const firstPromptLine = schedule.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (
    firstPromptLine ||
    i18n.t(
      schedule.target.type === "agent"
        ? "featurePages.schedules.untitledHeartbeat"
        : "featurePages.schedules.untitledSchedule",
    )
  );
}

/**
 * “立即运行”是否能安全下发：daemon 会拒绝已完成的任务，客户端也只对
 * new-agent 任务提供手动运行（已运行记录无法再次存储）。
 */
export function canRunScheduleNow(
  schedule: ScheduleSummary,
  state: ScheduleDerivedStateForActions,
): boolean {
  return isNewAgentSchedule(schedule) && (state === "active" || state === "paused");
}

/** 任务已结束或目标已不存在时，暂停/恢复没有意义。 */
export function canToggleSchedulePause(state: ScheduleDerivedStateForActions): boolean {
  return state === "active" || state === "paused";
}

/**
 * 行菜单能提供哪些执行操作。暂停/恢复对 heartbeat（agent 目标）同样有效，
 * 只有“立即运行”仅限 new-agent 任务。
 */
export function resolveScheduleMenuActions(
  schedule: ScheduleSummary,
  state: ScheduleDerivedStateForActions,
): { runNow: boolean; togglePause: boolean } {
  return {
    runNow: canRunScheduleNow(schedule, state),
    togglePause: canToggleSchedulePause(state),
  };
}

export type ScheduleDerivedStateForActions =
  | "active"
  | "paused"
  | "expired"
  | "finished"
  | "targetGone";

export type ScheduleStatusFilter = "active" | "ended";

/**
 * 已暂停的任务仍可恢复，所以归入“进行中”；只有已完成或已过期的任务才算“已结束”。
 */
export function matchesScheduleStatusFilter(
  schedule: ScheduleSummary,
  filter: ScheduleStatusFilter,
  now: number = Date.now(),
): boolean {
  if (schedule.status === "completed") {
    return filter === "ended";
  }
  if (schedule.expiresAt) {
    const expiresAt = Date.parse(schedule.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      return filter === "ended";
    }
  }
  return filter === "active";
}

export function matchesScheduleSearch(
  schedule: ScheduleSummary & { serverName?: string },
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const target = schedule.target.type === "new-agent" ? schedule.target.config.cwd : "";
  return [
    resolveScheduleTitle(schedule),
    schedule.name ?? "",
    schedule.prompt,
    schedule.serverName ?? "",
    target,
  ]
    .join("\n")
    .toLowerCase()
    .includes(normalized);
}

export function filterSchedulesForSidebar<T extends ScheduleSummary & { serverName?: string }>(
  schedules: readonly T[],
  filter: ScheduleStatusFilter,
  query: string,
  now: number = Date.now(),
): T[] {
  return schedules
    .filter(
      (schedule) =>
        matchesScheduleStatusFilter(schedule, filter, now) &&
        matchesScheduleSearch(schedule, query),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function everyMsToParts(ms: number): { value: number; unit: IntervalUnit } {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { value: 1, unit: "hours" };
  }
  if (ms % MS_PER_DAY === 0) {
    return { value: ms / MS_PER_DAY, unit: "days" };
  }
  if (ms % MS_PER_HOUR === 0) {
    return { value: ms / MS_PER_HOUR, unit: "hours" };
  }
  return { value: Math.max(1, Math.round(ms / MS_PER_MINUTE)), unit: "minutes" };
}

export function partsToEveryMs(value: number, unit: IntervalUnit): number {
  const normalized = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  return normalized * UNIT_MS[unit];
}

function formatEvery(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  if (value === 1) {
    if (unit === "minutes") {
      return i18n.t("featurePages.schedules.format.everyMinute");
    }
    if (unit === "hours") {
      return i18n.t("featurePages.schedules.format.everyHour");
    }
    return i18n.t("featurePages.schedules.format.everyDay");
  }
  if (unit === "minutes") {
    return i18n.t("featurePages.schedules.format.everyMinutes", { count: value });
  }
  if (unit === "hours") {
    return i18n.t("featurePages.schedules.format.everyHours", { count: value });
  }
  return i18n.t("featurePages.schedules.format.everyDays", { count: value });
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "every") {
    return formatEvery(cadence.everyMs);
  }
  return describeCron(cadence) ?? cadence.expression;
}

/**
 * Humanize a handful of common 5-field cron shapes. Returns null when the
 * expression is valid but not one of the recognized patterns (callers fall
 * back to showing the raw expression).
 */
export function describeCron(cadence: CronCadence): string | null {
  const trimmed = cadence.expression.trim();
  if (validateCron(trimmed) !== null) {
    return null;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = trimmed.split(/\s+/);

  // Only humanize the simple "fixed time" family: literal minute/hour with the
  // date fields either wildcarded or a recognized day-of-week constraint.
  const minuteNum = Number.parseInt(minute, 10);
  const isLiteralMinute = /^\d+$/.test(minute);
  const isWildcardMonth = month === "*";
  const isWildcardDom = dayOfMonth === "*";

  if (minute === "*" && hour === "*" && isWildcardMonth && isWildcardDom && dayOfWeek === "*") {
    return i18n.t("featurePages.schedules.format.everyMinute");
  }

  if (!isLiteralMinute || !isWildcardMonth || !isWildcardDom) {
    return null;
  }

  // "Every hour" / "Every hour at :MM"
  if (hour === "*") {
    if (dayOfWeek !== "*") {
      return null;
    }
    return minuteNum === 0
      ? i18n.t("featurePages.schedules.format.everyHour")
      : i18n.t("featurePages.schedules.format.everyHourAt", { minute: pad2(minuteNum) });
  }

  if (!/^\d+$/.test(hour)) {
    return null;
  }
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNum)}`;
  const timezone = cadence.timezone ?? "UTC";
  return describeCronDay(dayOfWeek, time, timezone);
}

function describeCronDay(dayOfWeek: string, time: string, timezone: string): string | null {
  if (dayOfWeek === "*") {
    return i18n.t("featurePages.schedules.format.dailyAt", { time, timezone });
  }
  if (dayOfWeek === "1-5") {
    return i18n.t("featurePages.schedules.format.weekdaysAt", { time, timezone });
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return i18n.t("featurePages.schedules.format.weekendsAt", { time, timezone });
  }
  if (/^\d$/.test(dayOfWeek)) {
    const key = DAY_LABEL_KEYS[Number.parseInt(dayOfWeek, 10)];
    return key
      ? i18n.t("featurePages.schedules.format.dayAt", {
          day: i18n.t(`featurePages.schedules.format.${key}`),
          time,
          timezone,
        })
      : null;
  }
  return null;
}

const CRON_FIELD_KEYS = {
  minute: "cronFieldMinute",
  hour: "cronFieldHour",
  "day-of-month": "cronFieldDayOfMonth",
  month: "cronFieldMonth",
  "day-of-week": "cronFieldDayOfWeek",
} as const;

type CronFieldName = keyof typeof CRON_FIELD_KEYS;

const CRON_FIELD_ERROR_PATTERN =
  /^Invalid cron (minute|hour|day-of-month|month|day-of-week) (field|step|range|value)(:.*)?$/;

/** 协议层只提供英文错误；按结构映射到当前语言，未知形态退化为通用文案。 */
function localizeCronError(error: string): string {
  if (error === "Cron expressions must have 5 fields") {
    return i18n.t("featurePages.schedules.form.cronErrorFieldCount");
  }

  const match = CRON_FIELD_ERROR_PATTERN.exec(error);
  if (!match) {
    return i18n.t("featurePages.schedules.form.cronErrorGeneric");
  }

  const [, field, kind, suffix] = match;
  const fieldLabel = i18n.t(
    `featurePages.schedules.form.${CRON_FIELD_KEYS[field as CronFieldName]}`,
  );
  if (kind === "field") {
    return i18n.t("featurePages.schedules.form.cronErrorField", { field: fieldLabel });
  }
  if (kind === "step") {
    return i18n.t(
      suffix
        ? "featurePages.schedules.form.cronErrorStepBase"
        : "featurePages.schedules.form.cronErrorStep",
      { field: fieldLabel },
    );
  }
  if (kind === "range") {
    return i18n.t("featurePages.schedules.form.cronErrorRange", { field: fieldLabel });
  }
  return i18n.t("featurePages.schedules.form.cronErrorValue", { field: fieldLabel });
}

export function validateCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return i18n.t("featurePages.schedules.form.cronRequired");
  }

  const error = validateCronExpression(trimmed);
  return error === null ? null : localizeCronError(error);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Forward-relative description of the next run, e.g. "in 3h", "in 2d", "soon".
 * Returns "" when there is no scheduled next run.
 */
export function formatNextRun(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return "";
  }

  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return i18n.t("featurePages.schedules.format.soon");
  }
  if (diffMs < MS_PER_MINUTE) {
    return i18n.t("featurePages.schedules.format.soon");
  }
  if (diffMs < MS_PER_HOUR) {
    const minutes = Math.round(diffMs / MS_PER_MINUTE);
    // Rounding can cross the unit boundary (59.6m -> 60m); carry to the next
    // unit instead of showing "in 60m".
    if (minutes < 60) {
      return i18n.t("featurePages.schedules.format.inMinutes", { count: minutes });
    }
    return i18n.t("featurePages.schedules.format.inHours", { count: 1 });
  }
  if (diffMs < MS_PER_DAY) {
    const hours = Math.round(diffMs / MS_PER_HOUR);
    if (hours < 24) {
      return i18n.t("featurePages.schedules.format.inHours", { count: hours });
    }
    return i18n.t("featurePages.schedules.format.inDays", { count: 1 });
  }
  return i18n.t("featurePages.schedules.format.inDays", {
    count: Math.round(diffMs / MS_PER_DAY),
  });
}
