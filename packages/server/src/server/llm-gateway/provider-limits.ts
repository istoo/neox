/**
 * A provider's limits as routing reads them (myna's `internal/provider`):
 * how long a key or account rests, how many requests may wait, when a
 * spend cap or a usage share holds it, and which newly listed models join
 * its picks. Pure over the config and what routing keeps.
 */
import type { GatewayAccount, GatewayProvider } from "./config.js";

/** myna's own rest after an allowance refusal that names no reset (`provider.go:220-230`). */
export const DEFAULT_QUOTA_REST_MS = 15 * 60_000;
/** myna's own cap while a key keeps failing (`provider.go:231-237`). */
export const DEFAULT_FAILURE_REST_CAP_MS = 10 * 60_000;
const DEFAULT_RATE_REST_CAP_MS = 30 * 60_000;
/** myna's `fallbackCooldown` (`fallback.go:43`): a failure's base rest, doubled by attempts. */
const FALLBACK_COOLDOWN_MS = 60_000;
const RATE_REST_MS = 60_000;
/** myna's `creditRest`: out of credit until someone tops it up. */
const CREDIT_REST_MS = 30 * 60_000;
/** myna's `restrictedRest`: an account its vendor restricted, until an appeal lifts it. */
const RESTRICTED_REST_MS = 2 * 60 * 60_000;
/** myna's `verifyRest`: an account its vendor wants verified. */
const VERIFY_REST_MS = 30 * 60_000;
/** myna's `overloadRest` / `overloadRestMost`: a vendor too busy for the request. */
const OVERLOAD_REST_MS = 30_000;
const OVERLOAD_REST_MOST_MS = 60_000;
/** myna's `longestWait`: the most a vendor's own "try again in" is trusted. */
const LONGEST_WAIT_MS = 60 * 60_000;

/**
 * What a refusal was, as myna's `failureOf` reads it, for the branches that
 * don't rest at all or rest a fixed while (`routing.go:1232-1460`).
 */
export type FailureKind =
  | "cut"
  | "zdr"
  | "offline"
  | "policy"
  | "openCodeBare"
  | "proxy"
  | "overloaded"
  | "restricted"
  | "verify"
  | "credit";

export interface FailureRestInput {
  status: number | null;
  /** How many times in a row this key failed; 1 is the first. */
  attempt?: number;
  provider: Pick<GatewayProvider, "quotaRest" | "restCapMs">;
  /** What the vendor said of its reset, already in epoch ms. */
  vendorResetAt?: number | null;
  /** The refusal said the allowance is spent, not that it is a rate limit. */
  quota?: boolean;
  /** The vendor's own "try again in", already in ms; a rate limit reads it too. */
  retryAfterMs?: number | null;
  /** What the failure was, where the caller can tell (myna's `failureOf`). */
  kind?: FailureKind;
  now: number;
}

/**
 * Whether a failure of this kind is counted against the key: myna counts
 * none for a turn its plugin cut, a ZDR refusal, a lost network, a
 * safety-policy refusal, OpenCode's bare 400, a proxy's own failure or a
 * vendor too busy (`routing.go:1232-1460`). A cut turn and the rest are
 * asked again without the key being any worse.
 */
export function failureCounted(kind: FailureKind | undefined): boolean {
  switch (kind) {
    case "cut":
    case "zdr":
    case "offline":
    case "policy":
    case "openCodeBare":
    case "proxy":
    case "overloaded":
      return false;
    default:
      return true;
  }
}

/**
 * How long to rest a key or account after a refusal (myna's
 * `restAfterMarked`, `routing.go:1227`). A failure that isn't the key's —
 * a cut turn, a ZDR or policy refusal, a lost network, OpenCode's bare
 * 400, a proxy — isn't set aside at all; a restricted account rests two
 * hours and one to be verified half an hour; a vendor too busy rests its
 * model a moment. Otherwise the vendor's own reset wins, then its
 * allowance rest (`quotaRest`, a daily time over a duration) or its credit
 * rest, else the gateway's backoff — a minute, doubling, held at
 * `restCapMs`. `restCapMs: 0` is myna's LimitRestOff/RestCapOff: a limit
 * or a failure that says nothing of why rests not at all; a refused key or
 * a window full still does.
 */
export function restForFailure(input: FailureRestInput): number {
  const kind = input.kind;
  if (kind !== undefined && NO_REST_KINDS.has(kind)) {
    return 0;
  }
  if (kind === "restricted") {
    return RESTRICTED_REST_MS;
  }
  if (kind === "verify") {
    return VERIFY_REST_MS;
  }
  if (kind === "overloaded") {
    return overloadRest(input.retryAfterMs);
  }
  const vendor = input.vendorResetAt ?? null;
  if (vendor !== null && vendor > input.now) {
    return vendor - input.now;
  }
  const cappedBy = input.provider.restCapMs;
  if (kind === "credit") {
    return creditRest(input.retryAfterMs, cappedBy);
  }
  const rateLimited = input.status === 429;
  const limited = rateLimited || input.quota === true;
  if (cappedBy === 0 && limited) {
    // myna's LimitRestOff: a limit never rests the key
    return 0;
  }
  if (rateLimited && input.quota === true) {
    return quotaRest(input);
  }
  if (cappedBy === 0 && input.status !== 401 && input.status !== 403) {
    // myna's RestCapOff: a failure that says nothing of why rests not at
    // all; a refused key keeps the gateway's backoff
    return 0;
  }
  return backoffRest(input, rateLimited, cappedBy);
}

/** The kinds that ask for no rest at all (myna's `restAfterMarked`). */
const NO_REST_KINDS = new Set<FailureKind>([
  "cut",
  "zdr",
  "offline",
  "policy",
  "openCodeBare",
  "proxy",
]);

/** A vendor too busy for the request: a moment, up to a minute if it says. */
function overloadRest(asked: number | null | undefined): number {
  const named = asked ?? 0;
  return named > 0 ? Math.min(named, OVERLOAD_REST_MOST_MS) : OVERLOAD_REST_MS;
}

/** Out of credit: half an hour, or as long as the vendor asks, up to an hour. */
function creditRest(asked: number | null | undefined, cappedBy: number | undefined): number {
  if (cappedBy === 0) {
    return 0;
  }
  const named = asked ?? 0;
  return named > 0 ? Math.min(named, LONGEST_WAIT_MS) : CREDIT_REST_MS;
}

/** Out of allowance: the provider's own rest, or the vendor's Retry-After. */
function quotaRest(input: FailureRestInput): number {
  const rest = quotaRestFor(input.provider, input.now);
  const asked = input.retryAfterMs ?? 0;
  const named = asked > 0 && asked < LONGEST_WAIT_MS ? asked : 0;
  return named > 0 ? Math.max(named, rest) : rest;
}

/** myna's backoff: a minute, then double, held at the cap. */
function backoffRest(
  input: FailureRestInput,
  rateLimited: boolean,
  cappedBy: number | undefined,
): number {
  const attempt = Math.max(1, Math.trunc(input.attempt ?? 1));
  const base = rateLimited ? RATE_REST_MS : FALLBACK_COOLDOWN_MS;
  const cap = restCapOf(cappedBy, rateLimited);
  const backoff = Math.min(base * 2 ** Math.min(attempt - 1, 10), cap);
  const asked = input.retryAfterMs ?? 0;
  return rateLimited && asked > backoff ? asked : backoff;
}

function restCapOf(configured: number | undefined, rateLimited: boolean): number {
  if (configured !== undefined && configured > 0) {
    return configured;
  }
  return rateLimited ? DEFAULT_RATE_REST_CAP_MS : DEFAULT_FAILURE_REST_CAP_MS;
}

/** The provider's allowance rest, or until the daily time it names. */
export function quotaRestFor(provider: Pick<GatewayProvider, "quotaRest">, now: number): number {
  const resetAt = provider.quotaRest?.resetAt;
  if (resetAt !== undefined && resetAt.trim().length > 0) {
    const next = nextDailyResetAt(resetAt, now);
    if (next !== null) {
      return next - now;
    }
  }
  const seconds = provider.quotaRest?.seconds ?? 0;
  return seconds > 0 ? seconds * 1000 : DEFAULT_QUOTA_REST_MS;
}

/**
 * The next occurrence of a time of day, "HH:MM" on this computer's clock
 * or "HH:MM+08:00" / "HH:MMZ" on the vendor's (myna's `ParseResetAt`).
 */
export function nextDailyResetAt(spec: string, now: number): number | null {
  const text = spec.trim();
  const match = /^(\d{1,2}):(\d{2})([+-]\d{2}:\d{2}|[Zz])?$/.exec(text);
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  const zone = match[3];
  const offset = zone === undefined ? localOffsetMs(now) : zoneOffsetMs(zone);
  if (offset === null) {
    return null;
  }
  // The wall clock where the reset time is told, then the next one there.
  const wall = now + offset;
  const day = Math.floor(wall / 86_400_000) * 86_400_000;
  let at = day + (hour * 60 + minute) * 60_000;
  if (at <= wall) {
    at += 86_400_000;
  }
  return at - offset;
}

/** This computer's offset from UTC at now, in milliseconds. */
function localOffsetMs(now: number): number {
  return -new Date(now).getTimezoneOffset() * 60_000;
}

function zoneOffsetMs(zone: string): number | null {
  if (zone === "Z" || zone === "z") {
    return 0;
  }
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (match === null) {
    return null;
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/** A vendor's reading of one usage window (myna's QuotaWindow). */
export interface UsageWindow {
  /** Its name as the vendor gives it: "5h", "7d", "5 hours", "Weekly". */
  key: string;
  usedPercent: number | null;
  resetsAt: number | null;
}

export interface UsageShare {
  /** The share of its usage window the account is used to at most. */
  usedPercent: number | null;
  /** Per-window readings, where the vendor gives them (`capWindows` reads these). */
  windows?: readonly UsageWindow[];
}

/**
 * Whether the user's cap holds this account: at or past its share of any
 * usage window (myna's WindowCaps). `account.capPercent` is the share of
 * every window; `account.capWindows` overrides one window by name, 100
 * being no cap there. `creditsMode: "off"` holds a window with no cap at
 * the vendor's own 100%, so its credits are not spent.
 */
export function accountAtUsageCap(
  account: Pick<GatewayAccount, "capPercent" | "capWindows" | "creditsMode">,
  reading: UsageShare | undefined,
): boolean {
  if (reading === undefined) {
    return false;
  }
  const cap = account.capPercent;
  if (reading.usedPercent !== null && cap !== undefined && cap < 100) {
    if (reading.usedPercent >= cap) {
      return true;
    }
  }
  const creditsHeld = account.creditsMode === "off";
  for (const window of reading.windows ?? []) {
    if (window.usedPercent === null) {
      continue;
    }
    const own = capOfWindow(account.capWindows, window.key);
    const share = own > 0 ? own : (cap ?? 0);
    if (share >= 100) {
      continue;
    }
    if (share > 0 && window.usedPercent >= share) {
      return true;
    }
    if (share === 0 && creditsHeld && window.usedPercent >= 100) {
      return true;
    }
  }
  return false;
}

/** The share set on one window by name, 0 when it has none of its own. */
function capOfWindow(windows: Record<string, number> | undefined, name: string): number {
  if (windows === undefined) {
    return 0;
  }
  const wanted = windowKeyOf(name);
  for (const [key, share] of Object.entries(windows)) {
    if (windowKeyOf(key) === wanted) {
      return share;
    }
  }
  return 0;
}

/**
 * How a window is matched to its cap (myna's WindowCapID, lower case and
 * trimmed), with the names the vendors and the CLI use for one window
 * folded together: Codex's headers say "5h"/"7d", a usage source may say
 * "5 hours"/"Weekly", and `neolix provider account-cap --window` takes
 * either.
 */
export function windowKeyOf(name: string): string {
  const key = name.trim().toLowerCase();
  if (/^(5h|5 hours?|five hours?|five_hour|5-hour)$/.test(key)) {
    return "5h";
  }
  if (/^(7d|7 days?|seven days?|seven_day|weekly|week)$/.test(key)) {
    return "7d";
  }
  return key;
}

/** Whether a dollar amount is at or past a spend cap (myna's SpendCap). */
export function spendCapReached(
  cap: Pick<NonNullable<GatewayAccount["spendCap"]>, "usd"> | undefined,
  spent: number,
): boolean {
  return cap !== undefined && cap.usd > 0 && spent >= cap.usd;
}

/** Whether one more request may wait for this key's slot. */
export function queueHasRoom(queueLength: number | undefined, waiting: number): boolean {
  return queueLength === undefined || queueLength <= 0 || waiting < queueLength;
}

/**
 * Whether a pool ends at its caps (myna's CapStop): every account that
 * serves the model is held by a cap, so a request gets 429 rather than
 * the fallbacks. `held` answers whether one account is held.
 */
export function poolAtCap(
  provider: Pick<GatewayProvider, "stopAtCap">,
  accounts: readonly GatewayAccount[],
  held: (account: GatewayAccount) => boolean,
): boolean {
  if (provider.stopAtCap !== true || accounts.length === 0) {
    return false;
  }
  return accounts.every(held);
}

/**
 * A model id against a provider's AutoInclude rules (myna's
 * `CleanAutoInclude`): a glob with `*` in it, any case, or a regular
 * expression after `re:` that matches the whole id.
 */
export function matchesAutoInclude(patterns: readonly string[] | undefined, id: string): boolean {
  if (patterns === undefined) {
    return false;
  }
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.startsWith("re:")) {
      try {
        if (new RegExp(`^(?:${pattern.slice(3)})$`, "i").test(id)) {
          return true;
        }
      } catch {
        // a rule that doesn't compile takes nothing
      }
      continue;
    }
    if (globMatches(pattern, id)) {
      return true;
    }
  }
  return false;
}

/** The listed models a rule takes: listed now, not before, and matching. */
export function autoIncludedModels(
  patterns: readonly string[] | undefined,
  listed: readonly string[],
  before: readonly string[],
): string[] {
  const had = new Set(before);
  return listed.filter((id) => !had.has(id) && matchesAutoInclude(patterns, id));
}

function globMatches(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) {
    return false;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(id);
}
