import { describe, expect, it } from "vitest";
import type { GatewayQuotaWire } from "@neolix/protocol/gateway";
import { findDueQuotaAlerts } from "./alerts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function quotaWithWindows(
  windows: Array<{
    id: string;
    kind: "allowance" | "tokens5h" | "tokens7d";
    usedPercent: number | null;
    resetsAt: number | null;
  }>,
): GatewayQuotaWire {
  return {
    until: NOW,
    accounts: [
      {
        id: "claude-main",
        provider: "claude",
        providerLabel: "Claude",
        account: "main",
        accountLabel: "Main",
        enabled: true,
        restingUntil: null,
        spendUsd: 0,
        monthlyUsdCap: null,
        canWarm: false,
        warmup: false,
        lastReadAt: NOW,
        history: [],
        windows: windows.map((window) => ({
          ...window,
          remaining: null,
          limit: null,
          pacePct: null,
        })),
      },
    ],
  } as GatewayQuotaWire;
}

describe("findDueQuotaAlerts", () => {
  it("does nothing while both alerts are off", () => {
    const quota = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 95, resetsAt: NOW + HOUR },
    ]);
    expect(
      findDueQuotaAlerts({
        quota,
        preferences: { usagePercent: 0, resetHours: 0 },
        notified: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("notifies once a window reaches the share used", () => {
    const quota = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 82, resetsAt: NOW + 10 * HOUR },
    ]);
    const due = findDueQuotaAlerts({
      quota,
      preferences: { usagePercent: 80, resetHours: 0 },
      notified: new Set(),
      now: NOW,
    });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: "usage", accountLabel: "Main", usedPercent: 82 });
  });

  it("leaves a window under the share used alone", () => {
    const quota = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 79, resetsAt: NOW + 10 * HOUR },
    ]);
    expect(
      findDueQuotaAlerts({
        quota,
        preferences: { usagePercent: 80, resetHours: 0 },
        notified: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("stays quiet for a window already notified until it resets", () => {
    const quota = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 90, resetsAt: NOW + 10 * HOUR },
    ]);
    const first = findDueQuotaAlerts({
      quota,
      preferences: { usagePercent: 80, resetHours: 0 },
      notified: new Set(),
      now: NOW,
    });
    const second = findDueQuotaAlerts({
      quota,
      preferences: { usagePercent: 80, resetHours: 0 },
      notified: new Set(first.map((alert) => alert.key)),
      now: NOW,
    });
    expect(second).toEqual([]);

    const nextWindow = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 90, resetsAt: NOW + 8 * 24 * HOUR },
    ]);
    const afterReset = findDueQuotaAlerts({
      quota: nextWindow,
      preferences: { usagePercent: 80, resetHours: 0 },
      notified: new Set(first.map((alert) => alert.key)),
      now: NOW,
    });
    expect(afterReset).toHaveLength(1);
  });

  it("reminds before a weekly window renews with room left", () => {
    const quota = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 40, resetsAt: NOW + 2 * HOUR },
    ]);
    const due = findDueQuotaAlerts({
      quota,
      preferences: { usagePercent: 0, resetHours: 12 },
      notified: new Set(),
      now: NOW,
    });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: "reset", hoursLeft: 2 });
  });

  it("does not remind for an almost-used window or a 5-hour window", () => {
    const quota = quotaWithWindows([
      { id: "weekly", kind: "tokens7d", usedPercent: 90, resetsAt: NOW + 2 * HOUR },
      { id: "five-hour", kind: "tokens5h", usedPercent: 10, resetsAt: NOW + 2 * HOUR },
    ]);
    expect(
      findDueQuotaAlerts({
        quota,
        preferences: { usagePercent: 0, resetHours: 12 },
        notified: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
  });
});
