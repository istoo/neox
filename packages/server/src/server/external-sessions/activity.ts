import type { SessionTraceSpan } from "./trace-spans.js";
import type { ExternalSessionTokens } from "./types.js";

/**
 * A session's work on one local date: the tokens its model responses used
 * and the seconds it was at work (myna's Day.Active, sessions.go:355: the
 * gap between two lines when under five minutes, put on the later line's
 * day). Trace spans carry the transcript's own timestamps, so the CLI's
 * `--days` table can show active time and split tokens by day, and, as myna
 * does, by model within the day.
 */
export interface SessionActivity {
  date: string;
  tokens: ExternalSessionTokens;
  activeSeconds: number;
  /** The day's tokens per model, when the transcript names one. */
  models: { model: string; tokens: ExternalSessionTokens }[];
}

/** myna's idleGap: a pause this long or longer is not work. */
export const IDLE_GAP_MS = 5 * 60_000;

interface Day {
  tokens: ExternalSessionTokens;
  activeMs: number;
  models: Map<string, ExternalSessionTokens>;
}

export function activityOfSpans(spans: readonly SessionTraceSpan[]): SessionActivity[] {
  const days = new Map<string, Day>();
  for (const span of spans) {
    if (span.kind !== "generation" || span.tokens === undefined) {
      continue;
    }
    const used = span.tokens.input + span.tokens.output;
    if (used === 0 && span.tokens.cacheRead === 0 && span.tokens.cacheWrite === 0) {
      continue;
    }
    const day = dayOf(days, span.endMs);
    day.tokens = addTokens(day.tokens, span.tokens);
    if (span.model !== undefined && span.model.length > 0) {
      day.models.set(span.model, addTokens(day.models.get(span.model) ?? ZERO, span.tokens));
    }
  }
  // Every recorded boundary, in order: the gaps between them are the work.
  const times = [...new Set(spans.flatMap((span) => [span.startMs, span.endMs]))]
    .filter((at) => Number.isFinite(at) && at > 0)
    .sort((left, right) => left - right);
  for (let index = 1; index < times.length; index += 1) {
    const gap = (times[index] ?? 0) - (times[index - 1] ?? 0);
    if (gap > 0 && gap < IDLE_GAP_MS) {
      dayOf(days, times[index] ?? 0).activeMs += gap;
    }
  }
  return [...days.entries()]
    .filter(([, day]) => day.activeMs > 0 || spent(day.tokens) > 0 || day.tokens.cacheRead > 0)
    .map(([date, day]) => ({
      date,
      tokens: day.tokens,
      activeSeconds: Math.round(day.activeMs / 1000),
      models: [...day.models.entries()].map(([model, tokens]) => ({ model, tokens })),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** The local date of a transcript line, as myna's dateOf. */
export function activityDate(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const ZERO: ExternalSessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function dayOf(days: Map<string, Day>, at: number): Day {
  const date = activityDate(at);
  const found = days.get(date);
  if (found !== undefined) {
    return found;
  }
  const day: Day = { tokens: { ...ZERO }, activeMs: 0, models: new Map() };
  days.set(date, day);
  return day;
}

function addTokens(
  left: ExternalSessionTokens,
  right: ExternalSessionTokens,
): ExternalSessionTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

function spent(tokens: ExternalSessionTokens): number {
  return tokens.input + tokens.output;
}
