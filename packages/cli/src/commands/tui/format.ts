import type { ExternalSession } from "@neolix/protocol/messages";
import type { GatewayUsageGroupWire, GatewayUsagePointWire } from "@neolix/protocol/gateway";

/**
 * Pure formatting, filtering and layout helpers for `neolix tui`. Kept apart
 * from the React components so the reducer-sized logic can be tested without
 * a terminal.
 */

export const PAGE_NAMES = [
  "agents",
  "providers",
  "routing",
  "usage",
  "sessions",
  "library",
] as const;
export type PageName = (typeof PAGE_NAMES)[number];
export const PAGE_COUNT = PAGE_NAMES.length;

export type UsagePeriod = "today" | "7d" | "30d" | "all";
export const USAGE_PERIODS: readonly UsagePeriod[] = ["today", "7d", "30d", "all"];
export const PERIOD_NAMES: Record<UsagePeriod, string> = {
  today: "today",
  "7d": "7 days",
  "30d": "30 days",
  all: "all time",
};

export type SessionRange = 0 | 1 | 2 | 3 | 4;
export const SESSION_RANGES: readonly { name: string; days: number }[] = [
  { name: "today", days: 1 },
  { name: "7 days", days: 7 },
  { name: "30 days", days: 30 },
  { name: "90 days", days: 90 },
  { name: "all", days: 0 },
];

/** The page a key goes to: 1–6, or [ and ] for the one before and the next. */
export function pageForKey(input: string, current: number): number | null {
  if (input.length === 1 && input >= "1" && input <= "6") {
    return Number(input) - 1;
  }
  if (input === "]") {
    return (current + 1) % PAGE_COUNT;
  }
  if (input === "[") {
    return (current + PAGE_COUNT - 1) % PAGE_COUNT;
  }
  return null;
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 10_000_000) return `${Math.round(n / 1e6)}M`;
  if (abs >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 100_000) return `${Math.round(n / 1e3)}K`;
  if (abs >= 1_000) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
  [0x200b, 0x200d],
  [0xfeff, 0xfeff],
];

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** A code point's cells on a terminal: 0 for combining marks, 2 for wide scripts. */
export function charWidth(codePoint: number): number {
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** How many terminal cells a string takes. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function pad(value: string, width: number): string {
  if (width <= 0) return value;
  const length = displayWidth(value);
  return length >= width ? value : value + " ".repeat(width - length);
}

export function truncate(value: string, width: number): string {
  const limit = Math.max(1, width);
  if (displayWidth(value) <= limit) return value;
  let out = "";
  let used = 0;
  for (const char of value) {
    const cells = charWidth(char.codePointAt(0) ?? 0);
    if (used + cells > limit - 1) break;
    out += char;
    used += cells;
  }
  return `${out}…`;
}

/** The rows around a cursor that fit in `visible`, as [start, end). */
export function windowSlice(total: number, cursor: number, visible: number): [number, number] {
  if (total <= 0) return [0, 0];
  const height = Math.max(1, visible);
  let start = 0;
  if (cursor >= height) {
    start = cursor - height + 1;
  }
  return [start, Math.min(total, start + height)];
}

export function ago(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const delta = Math.max(0, now.getTime() - at.getTime());
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return at.toISOString().slice(0, 10);
}

/** The start of a session range, local time; null for all time. */
export function rangeStart(days: number, now: Date): Date | null {
  if (days <= 0) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1 - days);
  return start;
}

export interface SessionFilter {
  days: number;
  model: string;
  folder: string;
}

export function filterSessions(
  sessions: readonly ExternalSession[],
  filter: SessionFilter,
  now: Date,
): ExternalSession[] {
  const start = rangeStart(filter.days, now);
  return sessions.filter((session) => {
    if (start !== null) {
      const last = new Date(session.last);
      if (Number.isNaN(last.getTime()) || last < start) return false;
    }
    if (filter.folder !== "" && session.cwd !== filter.folder) return false;
    if (filter.model !== "" && !session.models.some((item) => item.model === filter.model)) {
      return false;
    }
    return true;
  });
}

export function sessionSpent(session: ExternalSession): number {
  return session.tokens.input + session.tokens.output;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_TOKENS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function spent(tokens: TokenTotals): number {
  return tokens.input + tokens.output;
}

export function addTokens(left: TokenTotals, right: TokenTotals): TokenTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

export interface SessionShare {
  name: string;
  tokens: TokenTotals;
  cost: number;
  priced: boolean;
}

export interface SessionDay {
  date: string;
  tokens: TokenTotals;
  cost: number;
  activeSeconds: number | null;
}

export interface SessionStats {
  from: string;
  to: string;
  tokens: TokenTotals;
  cost: number;
  unpriced: number;
  daysUsed: number;
  activeSeconds: number | null;
  days: SessionDay[];
  models: SessionShare[];
  folders: SessionShare[];
}

function dayKey(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function addShare(
  map: Map<string, SessionShare>,
  name: string,
  add: TokenTotals,
  money: number,
  priced: boolean,
): void {
  const held = map.get(name) ?? { name, tokens: { ...ZERO_TOKENS }, cost: 0, priced: true };
  held.tokens = addTokens(held.tokens, add);
  held.cost += money;
  held.priced = held.priced && priced;
  map.set(name, held);
}

function dayOf(days: Map<string, SessionDay>, date: string): SessionDay {
  const held = days.get(date);
  if (held !== undefined) return held;
  const created = { date, tokens: { ...ZERO_TOKENS }, cost: 0, activeSeconds: null };
  days.set(date, created);
  return created;
}

/** Adds a session's per-day activity; false when the daemon sent none. */
function addActivityDays(
  days: Map<string, SessionDay>,
  session: ExternalSession,
  start: Date | null,
): boolean {
  const activity = session.activity ?? [];
  if (activity.length === 0) return false;
  for (const entry of activity) {
    if (start !== null && new Date(`${entry.date}T23:59:59`) < start) continue;
    const day = dayOf(days, entry.date);
    day.tokens = addTokens(day.tokens, entry.tokens);
    day.activeSeconds = (day.activeSeconds ?? 0) + entry.activeSeconds;
  }
  return true;
}

/** Without activity, the session's whole total goes on its last day. */
function addLastDay(
  days: Map<string, SessionDay>,
  session: ExternalSession,
  start: Date | null,
): void {
  const last = new Date(session.last);
  if (Number.isNaN(last.getTime())) return;
  if (start !== null && last < start) return;
  const day = dayOf(days, dayKey(last));
  day.tokens = addTokens(day.tokens, session.tokens);
  day.cost += session.cost;
}

/**
 * The range's totals, days and shares, aggregated from the sessions' own
 * activity (per-day tokens and active seconds) when the daemon sent it, and
 * otherwise from each session's whole total on its last day.
 */
export function sessionStats(
  sessions: readonly ExternalSession[],
  filter: SessionFilter,
  now: Date,
): SessionStats {
  const start = rangeStart(filter.days, now);
  const filtered = filterSessions(sessions, filter, now);
  const days = new Map<string, SessionDay>();
  const models = new Map<string, SessionShare>();
  const folders = new Map<string, SessionShare>();
  let tokens = { ...ZERO_TOKENS };
  let cost = 0;
  let unpriced = 0;

  for (const session of filtered) {
    tokens = addTokens(tokens, session.tokens);
    cost += session.cost;
    if (!session.priced) unpriced += 1;
    for (const model of session.models) {
      addShare(models, model.model, model.tokens, model.cost, model.priced);
    }
    addShare(folders, session.cwd, session.tokens, session.cost, session.priced);
    if (!addActivityDays(days, session, start)) addLastDay(days, session, start);
  }

  const sortedDays = [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
  let activeSeconds: number | null = null;
  for (const day of sortedDays) {
    if (day.activeSeconds === null) continue;
    activeSeconds = (activeSeconds ?? 0) + day.activeSeconds;
  }
  return {
    from: sortedDays[0]?.date ?? dayKey(start ?? now),
    to: sortedDays.at(-1)?.date ?? dayKey(now),
    tokens,
    cost,
    unpriced,
    daysUsed: sortedDays.length,
    activeSeconds,
    days: sortedDays,
    models: [...models.values()].sort((left, right) => spent(right.tokens) - spent(left.tokens)),
    folders: [...folders.values()].sort((left, right) => spent(right.tokens) - spent(left.tokens)),
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const BARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** A one-line timeline of tokens per bucket, myna's usage bars. */
export function seriesBars(series: readonly GatewayUsagePointWire[]): string {
  if (series.length === 0) return "";
  const totals = series.map((point) => point.inputTokens + point.outputTokens);
  const top = Math.max(...totals, 0);
  if (top <= 0) return "";
  const chars = totals.map((value) => {
    const index = value <= 0 ? 0 : Math.max(1, Math.round((value * (BARS.length - 1)) / top));
    return BARS[Math.min(BARS.length - 1, index)];
  });
  const last = series.at(-1);
  const first = series[0];
  return `${chars.join("")}  ${first?.label ?? ""} – ${last?.label ?? ""}`;
}

export function groupTokens(group: GatewayUsageGroupWire): number {
  return group.inputTokens + group.outputTokens;
}

export interface OptionItem {
  value: string;
  note?: string;
}

/** myna's withCurrent: the current value first, deduplicated. */
export function withCurrent(items: readonly OptionItem[], current: string): OptionItem[] {
  if (current === "") return [...items];
  const seen = new Set([current]);
  const note = items.find((item) => item.value === current)?.note;
  const out: OptionItem[] = [
    { value: current, note: note === undefined ? "current" : `${note} · current` },
  ];
  for (const item of items) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    out.push(item);
  }
  return out;
}

function subsequence(value: string, query: string): boolean {
  let index = 0;
  for (const char of value) {
    if (char === query[index]) index += 1;
    if (index >= query.length) return true;
  }
  return query.length === 0;
}

/** myna's score: prefix < substring < subsequence < note match; lower is better. */
export function scoreOption(value: string, note: string, query: string): number | null {
  const lower = value.toLowerCase();
  const needle = query.toLowerCase();
  if (lower.startsWith(needle)) return 0;
  const at = lower.indexOf(needle);
  if (at >= 0) return 1 + at;
  if (subsequence(lower, needle)) return 1000;
  if (note.toLowerCase().includes(needle)) return 2000;
  return null;
}

export function matchOptions(items: readonly OptionItem[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items.map((_, index) => index);
  return items
    .map((item, index) => ({
      index,
      score: scoreOption(item.value, item.note ?? "", needle),
    }))
    .filter((hit): hit is { index: number; score: number } => hit.score !== null)
    .sort((left, right) => left.score - right.score)
    .map((hit) => hit.index);
}

export function pickerChoice(
  items: readonly OptionItem[],
  match: readonly number[],
  cursor: number,
  custom: boolean,
  query: string,
): string | null {
  if (match.length > 0) {
    return items[match[Math.max(0, Math.min(cursor, match.length - 1))]]?.value ?? null;
  }
  const typed = query.trim();
  return custom && typed !== "" ? typed : null;
}

export function shortDate(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  if (Number.isNaN(at.getTime())) return date;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A check-in vendor's name, as its card shows it. */
export function checkinVendorName(by: string): string {
  switch (by) {
    case "workbuddy":
      return "WorkBuddy";
    case "minimax":
      return "MiniMax Code";
    case "trae":
      return "Trae CN";
    case "qoder":
      return "Qoder";
    default:
      return by;
  }
}

/**
 * What came of a daily check-in, in myna's words: the credits it gave, the
 * vendor's own app when the press has to happen there, or why it failed.
 */
export function checkinWord(
  outcome: string | undefined,
  credit?: number,
  streak?: number,
  msg?: string,
): string {
  const plus = credit !== undefined && credit > 0 ? ` +${credit}` : "";
  const days = streak !== undefined && streak > 1 ? ` · ${streak}-day streak` : "";
  switch (outcome) {
    case "claimed":
      return `checked in${plus}${days}`;
    case "done":
      return `already in${plus}`;
    case "ineligible":
      return "not eligible";
    case "inactive":
      return "no check-in event";
    case "captcha":
      return "needs a captcha in the app";
    case "own-app":
      return "do it in the app";
    case undefined:
      return "not checked in yet";
    default:
      return msg === undefined || msg === "" ? "failed" : `failed: ${msg}`;
  }
}

/** A compact `yyyy-mm-dd hh:mm`-free relative label for a window's reset. */
export function resetIn(iso: string | null | undefined, now: Date): string {
  if (iso === null || iso === undefined || iso === "") return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const delta = at.getTime() - now.getTime();
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
