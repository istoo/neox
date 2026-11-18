// FILE: gatewayMaskingScore.logic.ts
// Purpose: The local guard model's confidence threshold, picked as myna's
//          settings picks it: a publisher default plus the scores from 0.5
//          to 0.95, with an unusual stored score kept visible.

/** The publisher's threshold (myna's guard.MinScore); no stored score means this. */
export const MASKING_SCORE_DEFAULT = 0.8;

/** The scores myna's menu offers besides the default. */
export const MASKING_SCORES = [0.5, 0.6, 0.7, 0.85, 0.9, 0.95] as const;

/** The daemon's bounds for a stored threshold. */
export const MASKING_SCORE_MIN = 0.5;
export const MASKING_SCORE_MAX = 0.95;

/** Whether the daemon's config schema accepts this score. */
export function isMaskingScore(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    value >= MASKING_SCORE_MIN &&
    value <= MASKING_SCORE_MAX
  );
}

/** The score to show: the stored one, else the daemon's, else the default. */
export function effectiveMaskingScore(
  stored: number | undefined,
  fallback: number | undefined,
): number {
  if (stored !== undefined && Number.isFinite(stored)) return stored;
  if (fallback !== undefined && Number.isFinite(fallback)) return fallback;
  return MASKING_SCORE_DEFAULT;
}

/**
 * The menu's scores: myna's list, plus a stored score outside it so the page
 * shows what the config holds instead of silently moving it.
 */
export function maskingScoreOptions(stored: number | undefined): number[] {
  const scores: number[] = [...MASKING_SCORES];
  if (
    stored !== undefined &&
    Number.isFinite(stored) &&
    stored !== MASKING_SCORE_DEFAULT &&
    !scores.includes(stored)
  ) {
    scores.push(stored);
    scores.sort((left, right) => left - right);
  }
  return scores;
}

/** The select's value: an empty choice is the default (a stored 0.8 reads as it too). */
export function maskingScoreSelectValue(score: number): string {
  return score === MASKING_SCORE_DEFAULT ? "" : String(score);
}
