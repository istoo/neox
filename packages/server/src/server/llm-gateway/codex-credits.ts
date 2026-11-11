/**
 * How a Codex account spends its credits once a usage window is used up,
 * myna's codex_credits.go (CodexNoCredits, CodexCreditsFirst and
 * CodexCreditsLast). The default, "on", keeps answering on the vendor's
 * credits in its place; "first" keeps its place and Codex's sign-in before
 * moving on; "last" goes after everything else not on its credits; "off"
 * holds it as used up, so the other accounts, groups and fallbacks answer
 * instead and no credits are spent.
 *
 * Only the decision lives here; the routing layer applies it where a
 * candidate's window is used up.
 */

export type CodexCreditsMode = "on" | "first" | "last" | "off";

export const CODEX_CREDITS_MODES = ["on", "first", "last", "off"] as const;

export interface CodexCreditsPlan {
  /** Held as used up: the vendor's credits are not spent and routing moves on. */
  hold: boolean;
  /** Tried before the accounts with room, keeping its place and Codex's sign-in. */
  first: boolean;
  /** Tried after every account, key and fallback not on its credits. */
  last: boolean;
}

/** An account's mode; absent is "on", as myna's settings read it. */
export function codexCreditsMode(account: { creditsMode?: CodexCreditsMode }): CodexCreditsMode {
  return account.creditsMode ?? "on";
}

/** Whether the account may answer on its credits at all. */
export function codexSpendsCredits(account: { creditsMode?: CodexCreditsMode }): boolean {
  return codexCreditsMode(account) !== "off";
}

/**
 * Whether a spent account is kept on its credits instead of moving the
 * sign-in on. Only `first` does: it spends them before another account.
 * `on` (the default) spends them in its place, so the sign-in still moves
 * on; `last` and `off` do not keep it either. myna's CodexCreditsFirst.
 */
export function codexCreditsFirst(account: { creditsMode?: CodexCreditsMode }): boolean {
  return codexCreditsMode(account) === "first";
}

/**
 * What a window being used up does to the account's place. An unused-up
 * window leaves it in its ordinary place whatever the mode.
 */
export function codexCreditsPlan(
  account: { creditsMode?: CodexCreditsMode },
  windowUsedUp: boolean,
): CodexCreditsPlan {
  if (!windowUsedUp) {
    return { hold: false, first: false, last: false };
  }
  switch (codexCreditsMode(account)) {
    case "off":
      return { hold: true, first: false, last: false };
    case "first":
      return { hold: false, first: true, last: false };
    case "last":
      return { hold: false, first: false, last: true };
    default:
      return { hold: false, first: false, last: false };
  }
}
