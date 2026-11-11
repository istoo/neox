import {
  parseCronExpression,
  validateCronExpression,
} from "@neolix/protocol/schedule/cron-expression";
import type { ScheduleCadence } from "@neolix/protocol/schedule/types";

interface CronDateParts {
  year: number;
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function startOfNextMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid cron time zone: ${timeZone}`);
  }
}

function createCronDatePartsReader(timeZone: string | undefined): (date: Date) => CronDateParts {
  if (timeZone === undefined) {
    return (date: Date) => ({
      year: date.getUTCFullYear(),
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    });
  }

  assertValidTimeZone(timeZone);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (date: Date) => {
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    }

    const year = Number.parseInt(values.year, 10);
    const month = Number.parseInt(values.month, 10);
    const dayOfMonth = Number.parseInt(values.day, 10);

    return {
      year,
      minute: Number.parseInt(values.minute, 10),
      hour: Number.parseInt(values.hour, 10),
      dayOfMonth,
      month,
      dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
    };
  };
}

export function validateScheduleCadence(cadence: ScheduleCadence): void {
  if (cadence.type === "cron") {
    const error = validateCronExpression(cadence.expression);
    if (error) {
      throw new Error(error);
    }
    if (cadence.timezone !== undefined) {
      assertValidTimeZone(cadence.timezone);
    }
  }
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;
/** A fall-back day is 25 hours long. */
const MAX_MINUTES_IN_LOCAL_DAY = 26 * 60;
/**
 * A Gregorian leap day can be eight years away (2096 -> 2104), so the search
 * covers more than the 366 days a minute-by-minute scan used to.
 */
const MAX_SEARCH_DAYS = 8 * 366 + 2;

function sameLocalDate(left: CronDateParts, right: CronDateParts): boolean {
  return (
    left.year === right.year && left.month === right.month && left.dayOfMonth === right.dayOfMonth
  );
}

/** The first minute of the next local date, even across a DST shift. */
function firstMinuteOfNextDate(date: Date, readDateParts: (date: Date) => CronDateParts): Date {
  const parts = readDateParts(date);
  const minutesLeft = MINUTES_PER_DAY - (parts.hour * 60 + parts.minute);
  let next = new Date(date.getTime() + minutesLeft * MINUTE_MS);
  // A fall-back hour can leave this arithmetic inside the same local date.
  for (let step = 0; step < 180 && sameLocalDate(readDateParts(next), parts); step += 1) {
    next = new Date(next.getTime() + MINUTE_MS);
  }
  // A spring-forward can land past the date's first minute.
  const nextParts = readDateParts(next);
  for (let step = 0; step < 180; step += 1) {
    const previous = new Date(next.getTime() - MINUTE_MS);
    if (!sameLocalDate(readDateParts(previous), nextParts)) {
      break;
    }
    next = previous;
  }
  return next;
}

export function computeNextRunAt(cadence: ScheduleCadence, after: Date): Date {
  if (cadence.type === "every") {
    // COMPAT(scheduleEveryMs): execute legacy persisted rolling intervals until the
    // compatibility floor reaches v0.2.0. Added in v0.2.0; remove after 2027-01-17.
    return new Date(after.getTime() + cadence.everyMs);
  }

  const cron = parseCronExpression(cadence.expression);
  const hasWildcardDay = cron.dayOfMonth.isWildcard || cron.dayOfWeek.isWildcard;
  const readDateParts = createCronDatePartsReader(cadence.timezone);
  const matchesDay = (parts: CronDateParts): boolean => {
    if (!cron.month.matches(parts.month)) {
      return false;
    }
    const dayOfMonthMatches = cron.dayOfMonth.matches(parts.dayOfMonth);
    const dayOfWeekMatches = cron.dayOfWeek.matches(parts.dayOfWeek);
    const bothDaysMatch = dayOfMonthMatches && dayOfWeekMatches;
    const eitherDayMatches = dayOfMonthMatches || dayOfWeekMatches;
    return hasWildcardDay ? bothDaysMatch : eitherDayMatches;
  };

  let cursor = startOfNextMinute(after);
  for (let day = 0; day < MAX_SEARCH_DAYS; day += 1) {
    const dayParts = readDateParts(cursor);
    if (!matchesDay(dayParts)) {
      cursor = firstMinuteOfNextDate(cursor, readDateParts);
      continue;
    }

    for (let minute = 0; minute < MAX_MINUTES_IN_LOCAL_DAY; minute += 1) {
      const parts = readDateParts(cursor);
      if (!sameLocalDate(parts, dayParts)) {
        break;
      }
      if (cron.minute.matches(parts.minute) && cron.hour.matches(parts.hour)) {
        return cursor;
      }
      cursor = new Date(cursor.getTime() + MINUTE_MS);
    }
  }

  throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
}
