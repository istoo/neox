import { describe, expect, it } from "vitest";
import type { GatewayQuotaAccountWire, GatewayUsageReportWire } from "@neolix/protocol/gateway";

import {
  formatTrayPace,
  trayFigure,
  trayPercent,
  trayUsageData,
  trayUsageLabel,
  trayUsageTooltip,
  type TrayUsageFormat,
  type TrayUsageSettings,
  type TrayUsageWords,
} from "./tray-usage-model";

const SETTINGS: TrayUsageSettings = {
  trayUsages: [],
  trayNoLogos: false,
  trayPace: false,
  trayNoCost: false,
  trayWindows: {},
};

function account(overrides: Partial<GatewayQuotaAccountWire> = {}): GatewayQuotaAccountWire {
  return {
    id: "claude|a@b.c",
    provider: "claude",
    providerLabel: "Claude",
    account: "a@b.c",
    accountLabel: "a@b.c",
    enabled: true,
    restingUntil: null,
    windows: [
      {
        id: "5h",
        kind: "tokens5h",
        usedPercent: 62,
        remaining: null,
        limit: null,
        resetsAt: 1_000,
        pacePct: 3,
        windowMs: 5 * 60 * 60_000,
        history: [],
      },
      {
        id: "7d",
        kind: "tokens7d",
        usedPercent: 41,
        remaining: null,
        limit: null,
        resetsAt: 2_000,
        pacePct: null,
        windowMs: 7 * 24 * 60 * 60_000,
        history: [],
      },
    ],
    spendUsd: 0,
    monthlyUsdCap: null,
    canWarm: false,
    warmup: false,
    lastReadAt: null,
    history: [],
    ...overrides,
  };
}

function report(totals: Partial<GatewayUsageReportWire["totals"]>): GatewayUsageReportWire {
  return {
    totals: {
      calls: 3,
      failed: 0,
      retried: 0,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      costUsd: 0.5,
      ...totals,
    },
  } as GatewayUsageReportWire;
}

describe("trayUsageData", () => {
  it("keeps the order Settings names, cards and totals together", () => {
    const data = trayUsageData(
      { ...SETTINGS, trayUsages: ["usage:today", "claude|a@b.c"] },
      [account()],
      { today: report({}), week: null },
    );

    expect(data.totals.map((total) => total.id)).toEqual(["usage:today"]);
    expect(data.totals[0]?.tokens).toBe(165);
    expect(data.cards.map((card) => card.id)).toEqual(["claude|a@b.c"]);
    expect(data.cards[0]?.rows.map((row) => row.id)).toEqual(["5h", "7d"]);
  });

  it("shows the windows Settings picked, and every one in the tooltip", () => {
    const data = trayUsageData(
      {
        ...SETTINGS,
        trayUsages: ["claude|a@b.c"],
        trayWindows: { "claude|a@b.c": ["7d"] },
      },
      [account()],
      { today: null, week: null },
    );

    expect(data.cards[0]?.rows.map((row) => row.id)).toEqual(["7d"]);
    expect(data.cards[0]?.lines.map((row) => row.id)).toEqual(["5h", "7d"]);
  });

  it("falls back to every window when the picks are gone", () => {
    const data = trayUsageData(
      {
        ...SETTINGS,
        trayUsages: ["claude|a@b.c"],
        trayWindows: { "claude|a@b.c": ["month"] },
      },
      [account()],
      { today: null, week: null },
    );

    expect(data.cards[0]?.rows.map((row) => row.id)).toEqual(["5h", "7d"]);
  });

  it("leaves out accounts the host no longer has", () => {
    const data = trayUsageData({ ...SETTINGS, trayUsages: ["gone"] }, [account()], {
      today: null,
      week: null,
    });

    expect(data.cards).toEqual([]);
  });
});

describe("menu bar text", () => {
  const FORMAT: TrayUsageFormat = {
    locale: "en",
    displayAs: "used",
    currency: "usd",
    numberUnits: "compact",
    cnyPerUsd: 7.2,
  };
  const WORDS: TrayUsageWords = {
    todayIn: "Today in Neolix",
    last7DaysIn: "Last 7 days in Neolix",
    tokens: (value) => `${value} tokens`,
    requests: (value) => `${value} requests`,
    used: "used",
    left: "left",
    resetsIn: (when) => `resets in ${when}`,
  };

  it("names the first card and shows at most two figures", () => {
    const settings: TrayUsageSettings = {
      ...SETTINGS,
      trayUsages: ["claude|a@b.c"],
      trayPace: true,
    };
    const data = trayUsageData(settings, [account()], { today: null, week: null });

    expect(trayUsageLabel(data, settings, FORMAT)).toBe("Claude 62% +3% · 41%");
  });

  it("drops the name when the Mac draws the provider's mark instead", () => {
    const settings: TrayUsageSettings = { ...SETTINGS, trayUsages: ["claude|a@b.c"] };
    const data = trayUsageData(settings, [account()], { today: null, week: null });

    expect(trayUsageLabel(data, settings, { ...FORMAT, showProviderName: () => false })).toBe(
      "62% · 41%",
    );
  });

  it("shows a total's tokens and cost unless cost is off", () => {
    const settings: TrayUsageSettings = { ...SETTINGS, trayUsages: ["usage:today"] };
    const data = trayUsageData(settings, [], { today: report({}), week: null });

    expect(trayUsageLabel(data, settings, FORMAT)).toBe("Σ165 · $0.500");
    expect(trayUsageLabel(data, { ...settings, trayNoCost: true }, FORMAT)).toBe("Σ165");
  });

  it("spells every window and the reset out in the tooltip", () => {
    const settings: TrayUsageSettings = {
      ...SETTINGS,
      trayUsages: ["claude|a@b.c", "usage:today"],
      trayWindows: { "claude|a@b.c": ["5h"] },
      trayPace: true,
    };
    const data = trayUsageData(settings, [account()], { today: report({}), week: null });

    const tooltip = trayUsageTooltip(data, settings, FORMAT, WORDS, 0);
    expect(tooltip).toContain("Claude · a@b.c");
    expect(tooltip).toContain("5h: 62% used · +3% · resets in 1m");
    expect(tooltip).toContain("7d: 41% used");
    expect(tooltip).toContain("Today in Neolix");
    expect(tooltip).toContain("165 tokens · $0.500 · 3 requests");
  });

  it("says Neolix when Settings names nothing the host has", () => {
    const settings: TrayUsageSettings = { ...SETTINGS, trayUsages: ["gone"] };
    const data = trayUsageData(settings, [account()], { today: null, week: null });

    expect(trayUsageTooltip(data, settings, FORMAT, WORDS, 0)).toBe("Neolix");
  });
});

describe("tray figures", () => {
  it("turns the sign of a pace when what is left is shown", () => {
    expect(formatTrayPace(12, "used")).toBe("+12%");
    expect(formatTrayPace(12, "remaining")).toBe("−12%");
    expect(formatTrayPace(-8, "used")).toBe("−8%");
    expect(formatTrayPace(0, "used")).toBe("±0%");
  });

  it("shows what is left when the display setting says so", () => {
    expect(trayPercent(62, "used")).toBe(62);
    expect(trayPercent(62, "remaining")).toBe(38);
  });

  it("draws the first figure's digits alone, as Windows' icon", () => {
    expect(trayFigure("Claude 62% +3% · 41%")).toBe("62");
    expect(trayFigure("41% · 62%")).toBe("41");
    expect(trayFigure("Σ1.2M · $3.40")).toBeNull();
    expect(trayFigure("")).toBeNull();
  });
});
