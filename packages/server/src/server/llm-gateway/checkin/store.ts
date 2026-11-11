import { readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "../../private-files.js";

/**
 * What came of a day's check-in, as myna names it (`WorkBuddyCheckin`):
 * claimed by us, already in, not eligible, no event, or no answer.
 * `captcha` and `own-app` are answers that tell the user to act in the
 * vendor's own app.
 */
export type CheckinOutcome =
  | "claimed"
  | "done"
  | "ineligible"
  | "inactive"
  | "failed"
  | "captcha"
  | "own-app";

/**
 * One account's last check-in, as the vendor's file keeps it (myna's
 * `WorkBuddyCheckin` in `workbuddy-checkin.json` and
 * `minimax-checkin.json`). Times are RFC 3339 strings, as Go writes them.
 */
export interface CheckinRecord {
  /** The Beijing day (`YYYY-MM-DD`) it counts in. */
  day: string;
  at: string;
  outcome: CheckinOutcome;
  credit?: number;
  streak?: number;
  msg?: string;
  /** A campaign's end, or when the vendor's own day turns. */
  until?: string;
  /** A failure that never reached the vendor. */
  offline?: boolean;
  /** How many failures before this one the same day never reached it. */
  tries?: number;
  /** When the account's credits were last seen claimed. */
  claimed?: string;
}

/** Each account's entry, by key. */
export type CheckinState = Record<string, CheckinRecord>;

/** A file that can't be read or parsed: unknown, never empty. */
export class CheckinStateError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "CheckinStateError";
  }
}

/** Where a vendor's check-in file lives: `$NEOLIX_HOME/gateway/<vendor>-checkin.json`. */
export function checkinFilePath(gatewayDir: string, vendor: string): string {
  return path.join(gatewayDir, `${vendor}-checkin.json`);
}

/**
 * Reads a check-in file. A file that isn't there is empty. One that is
 * there but can't be read or doesn't parse is unknown: the caller asks no
 * account and writes nothing, so no account is checked in twice and no
 * unread entry is written over (myna's `readCheckins`).
 */
export async function readCheckins(filePath: string): Promise<CheckinState> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }
    throw new CheckinStateError(
      filePath,
      `${filePath} can't be read (${errorMessage(error)}): Neox leaves it as it is and checks in no account of it until it can`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw parseError(filePath, errorMessage(error));
  }
  if (parsed === null) {
    throw parseError(filePath, "it holds null");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw parseError(filePath, "it is not an object of check-ins");
  }

  const state: CheckinState = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    state[key] = parseRecord(filePath, key, value);
  }
  return state;
}

/** Replaces a check-in file in one step, 0600, as myna's `writePrivate` does. */
export async function writeCheckins(filePath: string, state: CheckinState): Promise<void> {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  await writePrivateFileAtomic(filePath, text);
}

function parseError(filePath: string, reason: string): CheckinStateError {
  return new CheckinStateError(
    filePath,
    `${filePath} doesn't parse (${reason}): Neox leaves it as it is and checks in no account of it until it does`,
  );
}

function parseRecord(filePath: string, key: string, value: unknown): CheckinRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw parseError(filePath, `its entry ${JSON.stringify(key)} is not an object`);
  }
  try {
    return parseRecordFields(value as Record<string, unknown>);
  } catch (error) {
    throw parseError(filePath, `its entry ${JSON.stringify(key)}: ${errorMessage(error)}`);
  }
}

function parseRecordFields(entry: Record<string, unknown>): CheckinRecord {
  const record: CheckinRecord = {
    day: optionalString(entry.day, "day") ?? "",
    at: optionalTime(entry.at, "at") ?? "",
    outcome: (optionalString(entry.outcome, "outcome") ?? "") as CheckinOutcome,
  };
  const credit = optionalNumber(entry.credit, "credit");
  if (credit !== undefined) record.credit = credit;
  const streak = optionalNumber(entry.streak, "streak");
  if (streak !== undefined) record.streak = streak;
  const msg = optionalString(entry.msg, "msg");
  if (msg !== undefined) record.msg = msg;
  const until = optionalTime(entry.until, "until");
  if (until !== undefined) record.until = until;
  if (entry.offline !== undefined) {
    if (typeof entry.offline !== "boolean") {
      throw new Error("offline is not a boolean");
    }
    record.offline = entry.offline;
  }
  const tries = optionalNumber(entry.tries, "tries");
  if (tries !== undefined) record.tries = tries;
  const claimed = optionalTime(entry.claimed, "claimed");
  if (claimed !== undefined) record.claimed = claimed;
  return record;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} is not a string`);
  }
  return value;
}

/** A time as Go writes one; an empty one is absent, as Go's zero time is. */
function optionalTime(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} is not a time`);
  }
  if (value !== "" && Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} is not a time`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} is not a number`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** The text an error says, with the cause Node's fetch wraps kept. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== "" && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * myna's plugin-auth.json (OpenCode's auth.json shape), by sign-in key:
 * `provider` or `provider#slot`. A missing or unreadable file is no
 * sign-ins, as myna's `plugin.Auths` gives nothing from it.
 */
export async function readPluginAuth(
  authPath: string,
): Promise<Record<string, Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(authPath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>;
    }
  }
  return out;
}

/** The provider a plugin sign-in key belongs to, before its `#slot`. */
export function providerOfKey(key: string): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

/** A string field of an auth entry; "" when absent or not a string. */
export function authString(auth: Record<string, unknown>, field: string): string {
  const value = auth[field];
  return typeof value === "string" ? value : "";
}

/** A number field of an auth entry; undefined when absent or not a number. */
export function authNumber(auth: Record<string, unknown>, field: string): number | undefined {
  const value = auth[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
