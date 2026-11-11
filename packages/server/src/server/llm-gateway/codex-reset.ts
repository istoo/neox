/**
 * A Codex rate-limit reset spent by itself, myna's codex_autoreset.go and
 * codex_expiring.go: before a reset about to run out is lost, or when the
 * account's week is used up, for the accounts the user lets spend them.
 *
 * Only the timing lives here; reading an account's resets from the Codex
 * backend and spending one belongs to the routing layer that holds the
 * account's sign-in.
 */

/** myna's CodexResetLeadDefault, CodexResetLeadLeast and CodexResetLeadMost. */
export const CODEX_RESET_LEAD_DEFAULT = 30;
export const CODEX_RESET_LEAD_LEAST = 15;
export const CODEX_RESET_LEAD_MOST = 24 * 60;

/** The choices myna's CLI offers, in minutes. */
export const CODEX_RESET_LEADS = [15, 30, 60, 120, 180, 360, 720, 1440] as const;

/** How long before a reset runs out it is spent; a value out of range is the default. */
export function resetLeadMinutes(value: number | null | undefined): number {
  return typeof value === "number" &&
    value >= CODEX_RESET_LEAD_LEAST &&
    value <= CODEX_RESET_LEAD_MOST
    ? value
    : CODEX_RESET_LEAD_DEFAULT;
}

/** When an account spends a reset by itself, myna's CodexAutoResetOnly. */
export type CodexAutoResetMode = "week" | "expiring" | "auto";

export interface CodexAutoResetWhen {
  week: boolean;
  expiring: boolean;
}

/** The two times a mode lets an account spend a reset, myna's CodexAutoResetWhen. */
export function autoResetWhen(mode: CodexAutoResetMode | undefined): CodexAutoResetWhen {
  return {
    week: mode === "week" || mode === "auto",
    expiring: mode === "expiring" || mode === "auto",
  };
}

/** The mode two switches mean; undefined is off. */
export function autoResetMode(week: boolean, expiring: boolean): CodexAutoResetMode | undefined {
  if (week && expiring) {
    return "auto";
  }
  if (week) {
    return "week";
  }
  return expiring ? "expiring" : undefined;
}

/** myna's resetExpiryClose, resetExpiryWatch and resetExpiryFar. */
export const RESET_EXPIRY_CLOSE_MS = 5 * 60_000;
export const RESET_EXPIRY_WATCH_MS = 30 * 60_000;
export const RESET_EXPIRY_FAR_MS = 6 * 60 * 60_000;

/**
 * How long before a reset runs out its account is looked at every
 * RESET_EXPIRY_CLOSE_MS: the lead and half an hour more, an hour at least,
 * so several looks fall inside the lead however long it is.
 */
export function resetExpiryNear(leadMinutes: number): number {
  return Math.max(60 * 60_000, leadMinutes * 60_000 + 30 * 60_000);
}

/**
 * When an account holding a reset that runs out at `until` is looked at
 * next: every close interval within the near window, every watch interval
 * before that but never past its start. Epoch ms.
 */
export function nextResetLook(input: { until: number; now: number; leadMinutes?: number }): number {
  const near = input.until - resetExpiryNear(resetLeadMinutes(input.leadMinutes));
  return near > input.now
    ? Math.min(input.now + RESET_EXPIRY_WATCH_MS, near)
    : input.now + RESET_EXPIRY_CLOSE_MS;
}

export interface ExpiringResetInput {
  /** When the soonest reset runs out. Epoch ms. */
  until: number;
  now: number;
  /** The account is held up by a used-up window now. */
  stopped: boolean;
  /** When it is free again; null when not known. Epoch ms. */
  back: number | null;
  leadMinutes?: number;
}

/**
 * When a reset that runs out at `until` is spent by itself, myna's
 * expiringResetSpent: the lead before it runs out, or now once that has
 * passed; now too when the account is stopped and not free again before
 * then, since what its windows have left can't be used while it waits.
 * 0 when the reset has run out already.
 */
export function expiringResetSpent(input: ExpiringResetInput): number {
  const { until, now, stopped, back } = input;
  if (until <= now) {
    return 0;
  }
  const at = until - resetLeadMinutes(input.leadMinutes) * 60_000;
  if (at <= now) {
    return now;
  }
  if (stopped && (back === null || back >= at)) {
    return now;
  }
  return at;
}
