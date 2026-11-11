/**
 * A group's patience (myna's patience.go): when every member has failed in
 * a way that passes — overloaded, busy, rate limited for a moment — and
 * nothing of the reply has gone to the agent, the request isn't ended on
 * the last one's error. After a pause, longer each round and never shorter
 * than a member's Retry-After, those members are asked again in turn, for
 * as long as the group's patience lasts. The decision and the state are
 * here; waiting and re-issuing stay in the attempt loop.
 */

/** How many times the members are asked again, at most. */
export const REPLAN_ROUNDS = 12;
/** The pause one retry starts from, doubling each round. */
export const RETRY_PAUSE_MS = 1000;
/** The longest pause between rounds. */
export const REPLAN_LONGEST_MS = 30 * RETRY_PAUSE_MS;
/** The patience of a provider that sets none. */
export const SINGLE_PATIENCE_MS = 60_000;
/** The longest patience either may set. */
export const PATIENCE_LONGEST_S = 240;

const CREDIT_WORDS =
  /insufficient.?(balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i;
const USED_UP_WORDS = /usage limit|quota|用量|额度/i;
const PROTECTION_WORDS = /response protection is unavailable/i;
const WALL_CODES = new Set(["user_model_rate_limited"]);

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether an error's code is an account's own slowly-refilling wall. */
function walled(body: string): boolean {
  const parsed = parseBody(body);
  const error = parsed?.error;
  const code =
    typeof error === "object" && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>).code
      : undefined;
  return typeof code === "string" && WALL_CODES.has(code);
}

/** Whether a vendor turned the request's content away. */
function protectionRefused(body: string): boolean {
  return PROTECTION_WORDS.test(body);
}

/**
 * Whether a failure is one a member may be over in a moment: overloaded,
 * unavailable, timed out, or a rate limit that isn't about money or an
 * account's token wall. The caller has already classified refusals the
 * vendor states in other ways; this reads the status and words.
 */
export function busy(status: number, body: string): boolean {
  if (status === 429) {
    return !CREDIT_WORDS.test(body) && !USED_UP_WORDS.test(body) && !walled(body);
  }
  if (
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529
  ) {
    return (
      !protectionRefused(body) &&
      !body.includes("did not stream") &&
      !CREDIT_WORDS.test(body) &&
      !USED_UP_WORDS.test(body)
    );
  }
  return false;
}

/** How long a member may be kept for replanning, in milliseconds. */
export function waitsOf(patienceSeconds: number, fallbackMs: number): number {
  if (patienceSeconds < 0) {
    return 0;
  }
  if (patienceSeconds === 0) {
    return fallbackMs;
  }
  return Math.min(patienceSeconds, PATIENCE_LONGEST_S) * 1000;
}

/** The longest budget among members, for holding the last failure. */
export function maxWaits(members: readonly { patience: number }[], fallbackMs: number): number {
  let longest = 0;
  for (const member of members) {
    longest = Math.max(longest, waitsOf(member.patience, fallbackMs));
  }
  return longest;
}

/** A member that failed in a way that passes, and when it may be asked. */
export interface BusyTry<C> {
  candidate: C;
  /** The account and effort, as myna's restKey: one member, one entry. */
  identity: string;
  readyAt: number;
  /** The member's own patience in seconds; 0 follows the group's. */
  patience: number;
}

/**
 * Adds a failed member to those to ask again, once, when its vendor said
 * it may be asked; a member already listed stays as it was.
 */
export function noteBusy<C>(
  list: readonly BusyTry<C>[],
  candidate: C,
  identity: string,
  waitMs: number,
  now: number,
  patience: number,
): BusyTry<C>[] {
  if (list.some((entry) => entry.identity === identity)) {
    return [...list];
  }
  return [...list, { candidate, identity, readyAt: now + waitMs, patience }];
}

export interface Replan<C> {
  candidates: C[];
  waitMs: number;
}

/**
 * Of the members that failed so, those to ask again and the pause before:
 * the pause doubled each round up to REPLAN_LONGEST_MS and never shorter
 * than the soonest Retry-After. A member whose own budget is spent, or
 * off, is left out; null when the rounds are spent or none is left.
 */
export function replan<C>(
  list: readonly BusyTry<C>[],
  round: number,
  waitFrom: number,
  fallbackMs: number,
  now: number,
): Replan<C> | null {
  if (list.length === 0 || round >= REPLAN_ROUNDS) {
    return null;
  }
  let wait = Math.min(RETRY_PAUSE_MS * 2 ** (round + 1), REPLAN_LONGEST_MS);
  const adjusted = list.map((entry) => {
    const budget = waitsOf(entry.patience, fallbackMs);
    if (budget <= 0) {
      return entry;
    }
    const end = waitFrom + budget;
    // A vendor's time is read in whole seconds: one back within a second
    // past the budget is asked as the budget ends.
    if (entry.readyAt > end && entry.readyAt <= end + 1000) {
      return { ...entry, readyAt: end };
    }
    return entry;
  });
  const soonest = Math.min(...adjusted.map((entry) => entry.readyAt));
  wait = Math.max(wait, soonest - now);
  const at = now + wait;
  const alive = adjusted.filter((entry) => {
    const budget = waitsOf(entry.patience, fallbackMs);
    return budget > 0 && at <= waitFrom + budget;
  });
  if (alive.length === 0) {
    return null;
  }
  const next: C[] = [];
  const later: C[] = [];
  for (const entry of alive) {
    if (entry.readyAt > at) {
      later.push(entry.candidate);
    } else {
      next.push(entry.candidate);
    }
  }
  return { candidates: [...next, ...later], waitMs: wait };
}

/** A Retry-After header's wait in milliseconds: seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now: number): number {
  if (value === null || value.trim() === "") {
    return 0;
  }
  const text = value.trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}
