import type { GatewayQuotaWire } from "@neolix/protocol/gateway";

/** myna's allowance and reset alerts: the share used, and how early before a renewal. */
export interface QuotaAlertPreferences {
  /** 1–100: notify when a window reaches this share used. 0 is off. */
  usagePercent: number;
  /** Notify this many hours before a window renews under 85% used. 0 is off. */
  resetHours: number;
}

export interface QuotaAlert {
  /** Stable per account, window and reset, so one window notifies once. */
  key: string;
  kind: "usage" | "reset";
  accountLabel: string;
  providerLabel: string;
  usedPercent: number;
  /** Hours until the window resets; null for a rolling window. */
  hoursLeft: number | null;
}

type QuotaAccount = GatewayQuotaWire["accounts"][number];
type QuotaWindow = QuotaAccount["windows"][number];

const HOUR_MS = 3_600_000;
/** A renewal reminder only makes sense when there is something left to use. */
const RESET_UNDER_USED = 85;

interface AlertInput {
  preferences: QuotaAlertPreferences;
  notified: ReadonlySet<string>;
  now: number;
}

/**
 * The alerts an allowance snapshot has due, skipping the ones already sent for
 * this window. A 5-hour token window has no renewal reminder: it resets too
 * often to remind about, as myna leaves it.
 */
export function findDueQuotaAlerts(input: AlertInput & { quota: GatewayQuotaWire }): QuotaAlert[] {
  if (input.preferences.usagePercent <= 0 && input.preferences.resetHours <= 0) {
    return [];
  }
  return input.quota.accounts.flatMap((account) =>
    account.enabled
      ? account.windows.flatMap((window) => alertsForWindow(account, window, input))
      : [],
  );
}

function alertsForWindow(
  account: QuotaAccount,
  window: QuotaWindow,
  input: AlertInput,
): QuotaAlert[] {
  const base = {
    accountLabel: account.accountLabel || account.id,
    providerLabel: account.providerLabel,
    usedPercent: window.usedPercent ?? 0,
    hoursLeft: hoursLeftFor(window, input.now),
  };
  const alerts: QuotaAlert[] = [];
  const usage = usageAlertFor(account, window, base, input);
  if (usage !== null) {
    alerts.push(usage);
  }
  const reset = resetAlertFor(account, window, base, input);
  if (reset !== null) {
    alerts.push(reset);
  }
  return alerts;
}

function hoursLeftFor(window: QuotaWindow, now: number): number | null {
  return window.resetsAt === null ? null : (window.resetsAt - now) / HOUR_MS;
}

function usageAlertFor(
  account: QuotaAccount,
  window: QuotaWindow,
  base: Omit<QuotaAlert, "key" | "kind">,
  input: AlertInput,
): QuotaAlert | null {
  const threshold = input.preferences.usagePercent;
  if (threshold <= 0 || (window.usedPercent ?? 0) < threshold) {
    return null;
  }
  const key = `usage|${account.id}|${window.id}|${window.resetsAt ?? "rolling"}`;
  if (input.notified.has(key)) {
    return null;
  }
  return { ...base, key, kind: "usage" };
}

function resetAlertFor(
  account: QuotaAccount,
  window: QuotaWindow,
  base: Omit<QuotaAlert, "key" | "kind">,
  input: AlertInput,
): QuotaAlert | null {
  const hours = input.preferences.resetHours;
  const hoursLeft = base.hoursLeft;
  if (hours <= 0 || window.resetsAt === null || window.kind === "tokens5h") {
    return null;
  }
  if (window.usedPercent === null) {
    return null;
  }
  if (hoursLeft === null || hoursLeft <= 0 || hoursLeft > hours) {
    return null;
  }
  if (base.usedPercent >= RESET_UNDER_USED) {
    return null;
  }
  const key = `reset|${account.id}|${window.id}|${window.resetsAt}`;
  if (input.notified.has(key)) {
    return null;
  }
  return { ...base, key, kind: "reset" };
}
