/**
 * When a subscription account's next window should be started, as myna's
 * codex_warmup.go and warmup_daily.go decide it from the account's own
 * windows: a window that has reset and had nothing used since is started by
 * one tiny request, and a chosen time of day starts the 5-hour one when it
 * isn't running.
 */

import type { UsageReportEntry } from "@neolix/protocol/messages";
import type { CodexLimit } from "./codex-limits.js";

export interface WarmWindow {
  /** "5h" or "7d" (the usage sources' own ids pass through). */
  id: string;
  /** Null when the vendor doesn't say. */
  usedPct: number | null;
  /** Epoch ms, null when the vendor doesn't say. */
  resetsAt: number | null;
}

export interface WarmDecision {
  warm: boolean;
  /** The window that asks for it, for the log and the settings page. */
  window: string | null;
}

/**
 * The windows one gateway account's subscription reports, or undefined when
 * no reading names it. The reports are the usage sources' (`provider.usage`
 * / `usage.list_reports`): one per signed-in account, `sourceId:key`, with
 * the vendor account's email as its label where the vendor says one.
 *
 * A gateway account matches by its id or label against that key or label;
 * a host with one account of that family and one report pairs them even
 * when neither names the other. Anything else is left unread rather than
 * guessed, so one account is never warmed on another's windows.
 */
export function windowsFromReports(
  reports: readonly UsageReportEntry[],
  family: "codex" | "claude",
  account: { id: string; label?: string; configDir?: string },
): WarmWindow[] | undefined {
  const picked = pickReport(reports, family, account);
  if (picked === undefined) {
    return undefined;
  }
  return picked.report.windows.map((window) => ({
    id: window.id,
    usedPct: window.usedPct ?? null,
    resetsAt: resetTime(window.resetsAt),
  }));
}

/**
 * Whether the account has credits to go on with, as its vendor reports
 * them: a `credits` balance with something left (myna's windows' `Credits`,
 * `subscription_usage.go:1055-1068`). Undefined when no reading names the
 * account or it reports no credits balance.
 */
export function creditsFromReports(
  reports: readonly UsageReportEntry[],
  family: "codex" | "claude",
  account: { id: string; label?: string; configDir?: string },
): boolean | undefined {
  const picked = pickReport(reports, family, account);
  if (picked === undefined) {
    return undefined;
  }
  const credits = picked.report.balances?.find((balance) => balance.unit === "credits");
  if (credits === undefined) {
    return undefined;
  }
  // A balance the vendor didn't put a figure on counts as credits held; a
  // spent one (0 or less) is none left.
  return credits.remaining === undefined || credits.remaining === null || credits.remaining > 0;
}

interface AvailableReport {
  entry: UsageReportEntry;
  report: Extract<UsageReportEntry["report"], { status: "available" }>;
}

/** The one report naming the account, as `windowsFromReports` pairs them. */
function pickReport(
  reports: readonly UsageReportEntry[],
  family: "codex" | "claude",
  account: { id: string; label?: string; configDir?: string },
): AvailableReport | undefined {
  const word = family === "codex" ? "codex" : "claude";
  const available: AvailableReport[] = reports.flatMap((entry) =>
    entry.sourceId.toLowerCase().includes(word) && entry.report.status === "available"
      ? [{ entry, report: entry.report }]
      : [],
  );
  return (
    available.find(({ entry }) => reportNames(entry, account)) ??
    (available.length === 1 ? available[0] : undefined)
  );
}

/**
 * The windows a Codex account's backend last reported, in its primary
 * (5-hour) and secondary (weekly) order: the reading the gateway keeps as
 * it answers that account, which needs no usage store and no label match.
 */
export function windowsFromCodexLimits(limits: readonly CodexLimit[]): WarmWindow[] | undefined {
  if (limits.length === 0) {
    return undefined;
  }
  return limits.map((limit) => ({
    id: codexWindowId(limit.windowMinutes),
    usedPct: limit.usedPercent,
    resetsAt: limit.resetAt,
  }));
}

function codexWindowId(windowMinutes: number): string {
  if (windowMinutes === 300) {
    return "5h";
  }
  if (windowMinutes === 10_080) {
    return "7d";
  }
  return `${windowMinutes}m`;
}

function reportNames(
  entry: UsageReportEntry,
  account: { id: string; label?: string; configDir?: string },
): boolean {
  const key = entry.id.slice(entry.id.indexOf(":") + 1).toLowerCase();
  const name = entry.account.label?.trim().toLowerCase() ?? "";
  if (key === account.id.toLowerCase()) {
    return true;
  }
  const label = account.label?.trim().toLowerCase() ?? "";
  if (label !== "" && (name === label || key === label)) {
    return true;
  }
  const dir = /[^\\/]+$/.exec(account.configDir ?? "")?.[0]?.toLowerCase();
  return dir !== undefined && dir !== "" && (key === dir || name === dir);
}

function resetTime(resetsAt: string | null | undefined): number | null {
  if (resetsAt === null || resetsAt === undefined) {
    return null;
  }
  const at = Date.parse(resetsAt);
  return Number.isNaN(at) ? null : at;
}

const TICK_SLACK_MS = 10 * 60_000;

/** The window a usage source's id names, by myna's names and the app's. */
export function windowKind(id: string): "5h" | "7d" | null {
  const name = id.toLowerCase();
  if (name === "5h" || name.includes("5 hour") || name.includes("five")) {
    return "5h";
  }
  if (name === "7d" || name.includes("week")) {
    return "7d";
  }
  return null;
}

/**
 * Whether the account should be warmed now: the weekly window with "week",
 * the 5-hour one too with "all", each once it has started over and nothing
 * has used it since. Null windows (a vendor that doesn't say) never ask for
 * a warm, and neither does "off".
 */
export function shouldWarm(input: {
  windows: readonly WarmWindow[];
  plan: "off" | "week" | "all";
  now: number;
  /** When the account was last warmed, 0 for never. */
  lastWarm: number;
}): WarmDecision {
  if (input.plan === "off") {
    return { warm: false, window: null };
  }
  const wanted = input.plan === "week" ? ["7d"] : ["7d", "5h"];
  for (const kind of wanted) {
    for (const window of input.windows) {
      if (windowKind(window.id) !== kind) {
        continue;
      }
      if (window.resetsAt === null || window.resetsAt > input.now) {
        continue;
      }
      if ((window.usedPct ?? 0) > 0) {
        continue;
      }
      if (input.lastWarm >= window.resetsAt) {
        continue;
      }
      return { warm: true, window: kind };
    }
  }
  return { warm: false, window: null };
}

/**
 * Whether one of the chosen local times of day asks for the 5-hour window to
 * be started now: the account has no 5-hour window running, and the time is
 * now or passed within the tick's slack. myna's warmup_daily.go.
 */
export function warmAtTime(input: {
  windows: readonly WarmWindow[];
  /** Local "HH:MM" times, earliest first. */
  times: readonly string[];
  now: number;
  lastDaily: number;
  /** The local clock the times were set on; absent is this host's. */
  timeZone?: string;
}): boolean {
  if (input.times.length === 0) {
    return false;
  }
  const running = input.windows.some((window) => {
    if (windowKind(window.id) !== "5h" || window.resetsAt === null) {
      return false;
    }
    return window.resetsAt > input.now + TICK_SLACK_MS;
  });
  if (running) {
    return false;
  }
  const local = localClock(input.now, input.timeZone);
  if (input.lastDaily >= local.midnight) {
    return false;
  }
  for (const time of input.times) {
    const minutes = clockMinutes(time);
    if (minutes === null) {
      continue;
    }
    const distance = local.minutes - minutes;
    if (distance >= 0 && distance <= TICK_SLACK_MS / 60_000) {
      return true;
    }
  }
  return false;
}

function localClock(
  now: number,
  timeZone: string | undefined,
): { day: string; minutes: number; midnight: number } {
  const date = new Date(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
  }
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  return { day, minutes, midnight: now - minutes * 60_000 };
}

function clockMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}
