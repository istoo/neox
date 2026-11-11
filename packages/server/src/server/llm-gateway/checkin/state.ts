import type { CheckinOutcome, CheckinRecord, CheckinState } from "./store.js";
import { errorMessage, readCheckins, writeCheckins } from "./store.js";

/**
 * The daily check-in's shared state machine, ported from myna's
 * `internal/provider/checkin.go` and `workbuddy_checkin.go`.
 *
 * Each account is checked in once a Beijing day. An answer that may be the
 * vendor's day before (a done, inactive or ineligible before noon with no
 * claim seen) is provisional and asked again every 30 minutes. A failure
 * that got an answer waits 30 minutes; one that never reached the vendor
 * backs off 1, 2, 4, 8, 16 and then 30 minutes.
 */

/** How often a provisional answer and a campaign are asked again. */
export const CHECKIN_EVERY_MS = 30 * 60_000;
/** How long a check-in that got an answer waits before another try. */
export const CHECKIN_RETRY_MS = 30 * 60_000;
/** How long a check-in that never reached the vendor waits on its first try. */
export const CHECKIN_SOON_MS = 60_000;
/** The Beijing hour from which a done, inactive or ineligible answer is the day's. */
export const CHECKIN_SURE_HOUR = 12;

// Beijing is UTC+8 all year, fixed so no time zone database is needed
// (myna's `beijing`).
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** The Beijing day (`YYYY-MM-DD`) a time falls on. */
export function beijingDay(value: Date | string): string {
  const time = toTime(value);
  if (time === null) return "";
  return new Date(time.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Beijing hour (0–23) a time falls in. */
export function beijingHour(value: Date | string): number {
  const time = toTime(value);
  if (time === null) return Number.NaN;
  return new Date(time.getTime() + BEIJING_OFFSET_MS).getUTCHours();
}

function toTime(value: Date | string): Date | null {
  const time = value instanceof Date ? value : new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

function timeOf(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Whether myna saw the account's credits claimed on day. */
export function claimedOn(record: CheckinRecord, day: string): boolean {
  if (record.outcome === "claimed" && record.day === day) return true;
  return record.claimed !== undefined && beijingDay(record.claimed) === day;
}

/**
 * Whether the record is the vendor's word on how its day stands with no
 * claim seen: an answer a press asks the vendor again for.
 */
export function unclaimedAnswer(record: CheckinRecord): boolean {
  return (
    (record.outcome === "done" ||
      record.outcome === "inactive" ||
      record.outcome === "ineligible") &&
    !claimedOn(record, record.day)
  );
}

/**
 * Whether the record may describe the vendor's day before: an unclaimed
 * answer given before noon Beijing (myna's #3326).
 */
export function isProvisional(record: CheckinRecord): boolean {
  return unclaimedAnswer(record) && beijingHour(record.at) < CHECKIN_SURE_HOUR;
}

/** Whether the day's credits are in, claimed now or before. */
export function isChecked(record: CheckinRecord): boolean {
  return record.outcome === "claimed" || record.outcome === "done";
}

/**
 * How long a failure waits to be tried again: 30 minutes, or one that
 * never reached the vendor 1 minute, doubled for each earlier try, capped
 * at 30 (myna's `retryAfter`).
 */
export function retryAfter(record: CheckinRecord): number {
  if (!record.offline) return CHECKIN_RETRY_MS;
  const tries = Math.min(record.tries ?? 0, 5);
  return Math.min(CHECKIN_RETRY_MS, CHECKIN_SOON_MS * 2 ** tries);
}

/**
 * Whether the record answers for day: it is that day's, not past `until`,
 * and not a failure still waiting for another try (at now; with soon, at
 * once).
 */
export function settled(record: CheckinRecord, day: string, now: Date, soon: boolean): boolean {
  if (record.day !== day) return false;
  const until = timeOf(record.until);
  if (until !== null && now.getTime() >= until) return false;
  if (record.outcome !== "failed") return true;
  if (soon) return false;
  const at = timeOf(record.at);
  return at !== null && now.getTime() - at < retryAfter(record);
}

/** What one account's vendor answered, before the day and time are kept. */
export interface CheckinResult {
  outcome: CheckinOutcome;
  credit?: number;
  streak?: number;
  msg?: string;
  until?: string;
  offline?: boolean;
}

/** An account a daily check-in reaches. */
export interface CheckinAccount {
  user: string;
  /** Its entry in the vendor's file; "" for one that can't be told apart. */
  key: string;
  /** The provider card a switch names, for a loop that skips it. */
  provider: string;
  on: boolean;
  run: (signal?: AbortSignal) => Promise<CheckinResult>;
}

/** A record as a reader is given it: the account's name and the Again mark. */
export interface CheckinEntry extends CheckinRecord {
  /** The account's key in its vendor's store. */
  key: string;
  user: string;
  by: string;
  /** Provisional: asked again later that day. Worked out when shown. */
  again: boolean;
  /** True for one checked in on this run, not one read back. */
  asked: boolean;
}

export interface RunCheckinOptions {
  /** The vendor's check-in file. */
  storePath: string;
  /** The vendor, `CheckinEntry.by`. */
  by: string;
  /** The time the run counts at; now by default. */
  now?: Date;
  /** A press for one account: only its key is asked, even while left out. */
  only?: string;
  /** A vendor whose campaigns can change before the Beijing day ends. */
  recheck?: boolean;
  /** Accounts left out of the daily check-in, by key. */
  off?: readonly string[];
  /** Logs a file that couldn't be written; the run still says how each stands. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}

const OFFLINE_CODES =
  /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/;

const OFFLINE_WORDS =
  /Unable to connect|socket connection was closed unexpectedly|other side closed|fetch failed/i;

/** Whether an error is a request that never reached the vendor. */
export function isOfflineError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && OFFLINE_CODES.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return OFFLINE_WORDS.test(errorMessage(error));
}

/** A non-2xx answer, kept so a provider can tell a 401 from another refusal. */
export class CheckinHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CheckinHttpError";
  }
}

/** A failure to keep and try again later that day. */
export function failedResult(error: unknown): CheckinResult {
  const result: CheckinResult = { outcome: "failed", msg: errorMessage(error) };
  if (isOfflineError(error)) {
    result.offline = true;
  }
  return result;
}

/**
 * Checks the accounts in for today that aren't yet, keeping what came of it
 * in the vendor's file. With soon, a failure is tried again without waiting
 * out its retry. It says how every account stands; those it didn't ask are
 * given as last kept (myna's `checkinNow`).
 */
export async function runCheckin(
  accounts: readonly CheckinAccount[],
  soon: boolean,
  options: RunCheckinOptions,
): Promise<CheckinEntry[]> {
  const now = options.now ?? new Date();
  const day = beijingDay(now);
  const off = new Set(options.off ?? []);

  let state: CheckinState;
  try {
    state = await readCheckins(options.storePath);
  } catch (error) {
    // Unknown, never empty: nothing is asked or written, the file is left
    // as it is, and each account says why.
    return unread(accounts, now, options, off, error);
  }

  const out: CheckinEntry[] = [];
  const asked = new Set<string>();
  let changed = false;

  for (const account of accounts) {
    if (!eligible(account, asked, options.only, off)) {
      continue;
    }
    asked.add(account.key);

    const previous = state[account.key];
    if (previous !== undefined && !shouldAsk(previous, day, now, soon, options.recheck === true)) {
      out.push(shown(previous, account.key, account.user, options.by, false));
      continue;
    }

    let result: CheckinResult;
    try {
      result = await account.run(options.signal);
    } catch (error) {
      result = failedResult(error);
    }
    const record = recordOf(result, day, now, previous);
    state[account.key] = record;
    changed = true;
    out.push(shown(record, account.key, account.user, options.by, true));
  }

  if (changed) {
    try {
      await writeCheckins(options.storePath, state);
    } catch (error) {
      options.onError?.(error);
    }
  }
  return out;
}

function reaches(key: string, only: string | undefined, off: ReadonlySet<string>): boolean {
  if (only !== undefined) return key === only;
  return !off.has(key);
}

function eligible(
  account: CheckinAccount,
  asked: ReadonlySet<string>,
  only: string | undefined,
  off: ReadonlySet<string>,
): boolean {
  return (
    account.on && account.key !== "" && !asked.has(account.key) && reaches(account.key, only, off)
  );
}

/**
 * Whether the record has to be asked again: a press asks an unclaimed
 * answer, the loop asks a provisional one every 30 minutes unless the
 * vendor said when its day turns, and a campaign is rechecked within the
 * Beijing day.
 */
function shouldAsk(
  previous: CheckinRecord,
  day: string,
  now: Date,
  soon: boolean,
  recheck: boolean,
): boolean {
  let isSettled = settled(previous, day, now, soon);
  if (soon && unclaimedAnswer(previous)) {
    isSettled = false;
  }
  if (isSettled && isProvisional(previous) && previous.until === undefined) {
    const at = timeOf(previous.at);
    isSettled = at !== null && now.getTime() - at < CHECKIN_EVERY_MS;
  }
  if (recheck) {
    const at = timeOf(previous.at);
    isSettled = isSettled && !soon && at !== null && now.getTime() - at < CHECKIN_EVERY_MS;
    if (isChecked(previous) && previous.until !== undefined) {
      const until = timeOf(previous.until);
      isSettled = isSettled && until !== null && now.getTime() < until;
    }
  }
  return !isSettled;
}

function shown(
  record: CheckinRecord,
  key: string,
  user: string,
  by: string,
  asked: boolean,
): CheckinEntry {
  return { ...record, key, user, by, again: isProvisional(record), asked };
}

function recordOf(
  result: CheckinResult,
  day: string,
  now: Date,
  previous: CheckinRecord | undefined,
): CheckinRecord {
  const at = now.toISOString();
  const record: CheckinRecord = { day, at, outcome: result.outcome };
  if (result.credit !== undefined && result.credit !== 0) record.credit = result.credit;
  if (result.streak !== undefined && result.streak !== 0) record.streak = result.streak;
  if (result.msg !== undefined && result.msg !== "") record.msg = result.msg;
  if (result.until !== undefined && result.until !== "") record.until = result.until;
  if (result.offline === true) record.offline = true;
  if (result.offline === true && previous?.day === day && previous.offline === true) {
    record.tries = (previous.tries ?? 0) + 1;
  }
  if (result.outcome === "claimed") {
    record.claimed = at;
  } else if (previous !== undefined && claimedOn(previous, day)) {
    record.claimed = previous.claimed ?? previous.at;
  }
  return record;
}

function unread(
  accounts: readonly CheckinAccount[],
  now: Date,
  options: RunCheckinOptions,
  off: ReadonlySet<string>,
  error: unknown,
): CheckinEntry[] {
  const out: CheckinEntry[] = [];
  const listed = new Set<string>();
  for (const account of accounts) {
    if (
      !account.on ||
      account.key === "" ||
      listed.has(account.key) ||
      !reaches(account.key, options.only, off)
    ) {
      continue;
    }
    listed.add(account.key);
    out.push({
      key: account.key,
      day: beijingDay(now),
      at: now.toISOString(),
      outcome: "failed",
      msg: errorMessage(error),
      user: account.user,
      by: options.by,
      again: false,
      asked: false,
    });
  }
  return out;
}
