/**
 * myna's balance alert: a key or account whose balance has fallen to the
 * amount the user set. The comparison happens in the balance's own currency
 * or credits, as the vendor words it; nothing is converted.
 */

export interface BalanceReading {
  /** `provider/account`, stable across polls. */
  key: string;
  providerLabel: string;
  accountLabel: string;
  /** The amount as shown to the user, e.g. "$1.20" or "1200 credits". */
  text: string;
  value: number;
}

export interface BalanceAlert {
  key: string;
  providerLabel: string;
  accountLabel: string;
  text: string;
}

/** What a balance endpoint's amount says, or null when it holds no number. */
export function parseBalanceAmount(
  amount: string | null | undefined,
): { value: number; text: string } | null {
  const text = (amount ?? "").trim();
  // A percentage is a share of something, not an amount to compare with one.
  if (text.length === 0 || text.includes("%")) {
    return null;
  }
  const match = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(text);
  if (match === null) {
    return null;
  }
  const parsed = Number.parseFloat(match[0].replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  // myna reads a vendor's shorthand: 1.5k, 2M credits.
  const rest = text.slice(match.index + match[0].length).trimStart();
  return { value: parsed * shorthandScale(rest), text };
}

function shorthandScale(rest: string): number {
  if (rest.startsWith("k") || rest.startsWith("K")) {
    return 1e3;
  }
  return rest.startsWith("M") ? 1e6 : 1;
}

/**
 * The alerts a poll has due. A balance that alerted stays quiet until it is
 * topped up past the threshold and falls again.
 */
export function findDueBalanceAlerts(input: {
  readings: readonly BalanceReading[];
  threshold: number;
  /** Keys whose last reading was at or below the threshold. */
  below: Set<string>;
}): BalanceAlert[] {
  if (input.threshold <= 0) {
    return [];
  }
  const due: BalanceAlert[] = [];
  for (const reading of input.readings) {
    if (reading.value > input.threshold) {
      input.below.delete(reading.key);
      continue;
    }
    if (input.below.has(reading.key)) {
      continue;
    }
    input.below.add(reading.key);
    due.push({
      key: reading.key,
      providerLabel: reading.providerLabel,
      accountLabel: reading.accountLabel,
      text: reading.text,
    });
  }
  return due;
}
