// FILE: scheduledTasks.ts
// Purpose: Pure helpers for the scheduled-tasks surface: grouping, row copy, template
//          prefills, and repeat-option ordering. UI components render these results.
// Layer: Web lib (pure domain/presentation helpers)
// Exports: group helpers, next-run/cadence formatters, template catalogue, repeat options.

import type { AutomationDefinition, AutomationSchedule } from "@synara/contracts";

import { automationLifecycleState } from "./automationStatus";
import type { AutomationFormState, ScheduleKind } from "./automationForm";
import { formatCadence, formatClockTime, weekdayLabel } from "./automationForm";
import { getFormatLocale, t } from "~/i18n";

/** The two buckets the scheduled-tasks panel renders. */
export type ScheduledTaskGroupId = "enabled" | "paused";

export type ScheduledTaskGroup<T extends { readonly enabled: boolean }> = {
  readonly id: ScheduledTaskGroupId;
  readonly definitions: readonly T[];
};

/**
 * Enabled tasks stay visible; every disabled task (user-paused, auto-stopped after
 * failures, run-limit stops, completed one-shots) goes to the collapsible paused group.
 * Ordering is inherited from the caller so the server's order never changes here.
 */
export function groupScheduledTasks<T extends { readonly enabled: boolean }>(
  definitions: readonly T[],
): readonly ScheduledTaskGroup<T>[] {
  return [
    { id: "enabled", definitions: definitions.filter((definition) => definition.enabled) },
    { id: "paused", definitions: definitions.filter((definition) => !definition.enabled) },
  ];
}

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

const NEXT_RUN_TIME_OPTIONS = { hour: "2-digit", minute: "2-digit" } as const;
const NEXT_RUN_DATE_OPTIONS = {
  month: "short",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
} as const;

/**
 * Absolute next-run phrase for list rows: "Today at 10:00", "Tomorrow at 10:00",
 * "Nov 13, Thu, 10:00". Null when unscheduled/unparseable so the row drops the segment.
 */
export function formatScheduledTaskNextRun(
  nextRunAt: string | null,
  now: number = Date.now(),
  locale: string = getFormatLocale(),
): string | null {
  if (!nextRunAt) return null;
  const date = new Date(nextRunAt);
  if (Number.isNaN(date.getTime())) return null;
  const time = new Intl.DateTimeFormat(locale, NEXT_RUN_TIME_OPTIONS).format(date);
  const dayDelta = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86_400_000);
  if (dayDelta === 0) return t("automation:relativeTimestamp_today", { time });
  if (dayDelta === 1) return t("automation:relativeTimestamp_tomorrow", { time });
  return new Intl.DateTimeFormat(locale, NEXT_RUN_DATE_OPTIONS).format(date);
}

/** Short repeat-rule label for a row subtitle ("Daily", "Weekdays", "Weekly · Wed"). */
export function scheduledTaskCadenceLabel(
  schedule: AutomationSchedule,
  locale: string = getFormatLocale(),
): string {
  switch (schedule.type) {
    case "daily":
      return t("automation:repeat_daily");
    case "weekdays":
      return t("automation:repeat_weekdays");
    case "weekly":
      return t("automation:scheduleRepeat_weekly", {
        day: weekdayLabel(schedule.dayOfWeek, locale),
      });
    case "interval":
      return formatCadence(schedule, locale);
    case "cron":
      return t("automation:repeat_cron");
    case "once":
      return t("automation:repeat_once");
    case "manual":
      return t("automation:repeat_manual");
    case "project-event":
      return t("automation:projectEvents");
  }
}

/**
 * The row's second line: "Tomorrow at 10:00 · Daily" for an enabled task, and a
 * lifecycle reason plus cadence for anything that is not currently scheduled.
 */
export function scheduledTaskRowDetail(
  definition: AutomationDefinition,
  now: number = Date.now(),
  locale: string = getFormatLocale(),
): string {
  const cadence = scheduledTaskCadenceLabel(definition.schedule, locale);
  if (!definition.enabled) {
    const state =
      automationLifecycleState(definition) === "done"
        ? t("git:detail_done")
        : t("automation:detail_paused");
    return `${state} · ${cadence}`;
  }
  const nextRun = formatScheduledTaskNextRun(definition.nextRunAt, now, locale);
  return nextRun ? `${nextRun} · ${cadence}` : cadence;
}

/** Locale-aware zone label ("China Standard Time") with the IANA id as fallback. */
export function scheduledTaskTimezoneLabel(
  timezone: string,
  locale: string = getFormatLocale(),
): string {
  const trimmed = timezone.trim();
  if (!trimmed) return "";
  try {
    const part = new Intl.DateTimeFormat(locale, {
      timeZone: trimmed,
      timeZoneName: "long",
    })
      .formatToParts(new Date())
      .find((entry) => entry.type === "timeZoneName");
    return part?.value || trimmed;
  } catch {
    return trimmed;
  }
}

export type ScheduledTaskTemplate = {
  readonly id: string;
  readonly nameKey: string;
  readonly descriptionKey: string;
  readonly promptKey: string;
  readonly scheduleKind: ScheduleKind;
  readonly timeOfDay?: string;
  readonly dayOfWeek?: number;
};

/** Programming-scenario starters behind the empty-state template wall. */
export const SCHEDULED_TASK_TEMPLATES: readonly ScheduledTaskTemplate[] = [
  {
    id: "code-review",
    nameKey: "automation:template_codeReview_name",
    descriptionKey: "automation:template_codeReview_description",
    promptKey: "automation:template_codeReview_prompt",
    scheduleKind: "daily",
    timeOfDay: "09:00",
  },
  {
    id: "dependencies",
    nameKey: "automation:template_dependencies_name",
    descriptionKey: "automation:template_dependencies_description",
    promptKey: "automation:template_dependencies_prompt",
    scheduleKind: "weekly",
    timeOfDay: "09:00",
    dayOfWeek: 1,
  },
  {
    id: "failing-tests",
    nameKey: "automation:template_failingTests_name",
    descriptionKey: "automation:template_failingTests_description",
    promptKey: "automation:template_failingTests_prompt",
    scheduleKind: "daily",
    timeOfDay: "18:00",
  },
  {
    id: "release-notes",
    nameKey: "automation:template_releaseNotes_name",
    descriptionKey: "automation:template_releaseNotes_description",
    promptKey: "automation:template_releaseNotes_prompt",
    scheduleKind: "weekly",
    timeOfDay: "16:00",
    dayOfWeek: 5,
  },
  {
    id: "security-scan",
    nameKey: "automation:template_securityScan_name",
    descriptionKey: "automation:template_securityScan_description",
    promptKey: "automation:template_securityScan_prompt",
    scheduleKind: "daily",
    timeOfDay: "08:00",
  },
  {
    id: "tech-debt",
    nameKey: "automation:template_techDebt_name",
    descriptionKey: "automation:template_techDebt_description",
    promptKey: "automation:template_techDebt_prompt",
    scheduleKind: "weekly",
    timeOfDay: "10:00",
    dayOfWeek: 1,
  },
  {
    id: "docs-sync",
    nameKey: "automation:template_docsSync_name",
    descriptionKey: "automation:template_docsSync_description",
    promptKey: "automation:template_docsSync_prompt",
    scheduleKind: "daily",
    timeOfDay: "17:00",
  },
  {
    id: "perf-regression",
    nameKey: "automation:template_perfRegression_name",
    descriptionKey: "automation:template_perfRegression_description",
    promptKey: "automation:template_perfRegression_prompt",
    scheduleKind: "weekly",
    timeOfDay: "10:00",
    dayOfWeek: 3,
  },
];

/**
 * Form fields a template pre-fills: display name, instructions, and its cadence.
 * The dialog merges this over a fresh draft, so timezone/project/model stay local.
 */
export function scheduledTaskTemplateDraft(
  template: ScheduledTaskTemplate,
  translate: typeof t = t,
): Partial<AutomationFormState> {
  return {
    name: translate(template.nameKey),
    prompt: translate(template.promptKey),
    scheduleKind: template.scheduleKind,
    timeOfDay: template.timeOfDay ?? "09:00",
    dayOfWeek: String(template.dayOfWeek ?? 1),
  };
}

export type ScheduledTaskRepeatOption = {
  readonly value: ScheduleKind;
  readonly label: string;
};

/** Main repeat choices in ChatGPT order; manual/once only appear when already selected. */
export function scheduledTaskRepeatOptions(
  current: ScheduleKind,
  translate: typeof t = t,
): readonly ScheduledTaskRepeatOption[] {
  const options: ScheduledTaskRepeatOption[] = [
    { value: "daily", label: translate("automation:repeat_daily") },
    { value: "weekdays", label: translate("automation:repeat_weekdays") },
    { value: "weekly", label: translate("automation:repeat_weekly") },
    { value: "hourly", label: translate("automation:repeat_hourly") },
    { value: "custom", label: translate("automation:repeat_custom") },
    { value: "cron", label: translate("automation:repeat_cron") },
  ];
  if (current === "once") {
    options.push({ value: "once", label: translate("automation:repeat_once") });
  }
  if (current === "manual") {
    options.push({ value: "manual", label: translate("automation:repeat_manual") });
  }
  return options;
}

/** Human-readable clock for a time-of-day row ("09:00" → "9:00"). */
export function scheduledTaskTimeLabel(timeOfDay: string): string {
  return formatClockTime(timeOfDay);
}
