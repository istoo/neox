import { describe, expect, it } from "vitest";
import { createAccountRoutingState } from "./accounts.js";
import type { GatewayProvider } from "./config.js";
import { findAccount, snapshotGatewayQuota } from "./quota-cards.js";
import type { QuotaHistoryEntry } from "./quota-history.js";
import { QuotaTracker } from "./quota.js";
import { RestTable } from "./routing.js";

const NOW = 10 * 3_600_000;
const FIVE_HOURS_MS = 5 * 3_600_000;

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "anthropic",
    baseUrl: "https://example.test/v1",
    accounts: [
      {
        id: "a",
        priority: 0,
        weight: 1,
        enabled: true,
        models: [],
        quota: { tokens5h: 1_000, tokens7d: 10_000 },
      },
    ],
    models: [{ id: "m" }],
    maxAccounts: undefined,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    ...overrides,
  };
}

function runtimeOf() {
  const accountState = createAccountRoutingState(new RestTable());
  const quotaTracker = new QuotaTracker();
  return {
    accountState,
    quotaTracker,
    routingState: { rest: new RestTable() },
  };
}

function historyEntry(at: number, resetAt: number | null): QuotaHistoryEntry {
  return {
    at,
    provider: "p",
    account: "a",
    remaining: 100,
    limit: 1_000,
    resetAt,
    usedPercent: 90,
  };
}

describe("snapshotGatewayQuota", () => {
  it("draws the usage endpoint's window and the token caps", () => {
    const runtime = runtimeOf();
    runtime.accountState.usage.set("p/a", {
      remaining: 250,
      limit: 1_000,
      usedPercent: 75,
      resetAt: NOW + 1_800_000,
      readAt: NOW - 60_000,
    });
    runtime.quotaTracker.record("p/a", NOW - 60_000, 500);
    const history = new Map([["p/a", [historyEntry(NOW - 1_800_000, NOW + 1_800_000)]]]);

    const quota = snapshotGatewayQuota({
      providers: [provider()],
      runtime,
      history,
      usage: [
        {
          at: NOW - 1_800_000,
          provider: "p",
          account: "a",
          tokens: 500,
          costUsd: 0.5,
          cacheReadTokens: 100,
        },
        {
          at: NOW - 600_000,
          provider: "p",
          account: "a",
          tokens: 250,
          costUsd: 0.25,
          cacheReadTokens: 0,
        },
      ],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });

    expect(quota.accounts).toHaveLength(1);
    const account = quota.accounts[0]!;
    expect(account).toMatchObject({
      id: "p/a",
      provider: "p",
      providerLabel: "p",
      accountLabel: "a",
      enabled: true,
      // 75% used: the window has started, so Warm up is not offered.
      canWarm: false,
      lastReadAt: NOW - 60_000,
    });
    const [usage, fiveHours, sevenDays] = account.windows;
    expect(usage).toMatchObject({
      id: "usage",
      kind: "allowance",
      usedPercent: 75,
      remaining: 250,
      limit: 1_000,
      resetsAt: NOW + 1_800_000,
      // Half way through its cycle with 75% used: 25 points ahead of an even burn.
      pacePct: 25,
      // The two calls since the cycle began: 750 tokens over 75% used.
      holds: {
        tokens: 1_000,
        costUsd: 1,
        priced: true,
        calls: 2,
        cacheReadTokens: 100,
        since: NOW - 1_800_000,
      },
    });
    expect(fiveHours).toMatchObject({
      id: "tokens5h",
      kind: "tokens5h",
      usedPercent: 50,
      remaining: 500,
      limit: 1_000,
      resetsAt: null,
      windowMs: 5 * 3_600_000,
      // Replayed from the ledger: 500 tokens, then 750 inside the five hours.
      history: [
        { at: NOW - 1_800_000, usedPercent: 50, resetsAt: null },
        { at: NOW - 600_000, usedPercent: 75, resetsAt: null },
      ],
    });
    expect(sevenDays).toMatchObject({ id: "tokens7d", usedPercent: 5, remaining: 9_500 });
    expect(account.history).toEqual([
      { at: NOW - 1_800_000, usedPercent: 90, resetsAt: NOW + 1_800_000 },
    ]);
  });

  it("carries the computer a shared reading came from", () => {
    const runtime = runtimeOf();
    runtime.accountState.usage.set("p/a", {
      remaining: 250,
      limit: 1_000,
      usedPercent: 75,
      resetAt: NOW + 1_800_000,
      readAt: NOW - 60_000,
    });
    const history = new Map([
      ["p/a", [{ ...historyEntry(NOW - 1_800_000, NOW + 1_800_000), device: "other" }]],
    ]);

    const quota = snapshotGatewayQuota({
      providers: [provider()],
      runtime,
      history,
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });

    expect(quota.accounts[0]?.history).toEqual([
      {
        at: NOW - 1_800_000,
        usedPercent: 90,
        resetsAt: NOW + 1_800_000,
        device: "other",
      },
    ]);
  });

  it("leaves out an account with neither a reading nor token caps", () => {
    const quota = snapshotGatewayQuota({
      providers: [
        provider({
          accounts: [{ id: "bare", priority: 0, weight: 1, enabled: true, models: [] }],
        }),
      ],
      runtime: runtimeOf(),
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });
    expect(quota.accounts).toEqual([]);
  });

  it("leaves out a disabled provider", () => {
    const quota = snapshotGatewayQuota({
      providers: [provider({ enabled: false })],
      runtime: runtimeOf(),
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });
    expect(quota.accounts).toEqual([]);
  });

  it("offers Warm up only while the five-hour window has not started", () => {
    const runtime = runtimeOf();
    // Reset a little under five hours away, nothing used: the window is idle.
    runtime.accountState.usage.set("p/a", {
      remaining: 1_000,
      limit: 1_000,
      usedPercent: 0,
      resetAt: NOW + FIVE_HOURS_MS - 60_000,
      readAt: NOW,
    });
    const idle = snapshotGatewayQuota({
      providers: [provider()],
      runtime,
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });
    expect(idle.accounts[0]?.canWarm).toBe(true);

    // A call inside the five hours the reset closes says it has started.
    const started = snapshotGatewayQuota({
      providers: [provider()],
      runtime,
      history: new Map(),
      usage: [
        {
          at: NOW - 60_000,
          provider: "p",
          account: "a",
          tokens: 10,
          costUsd: 0,
          cacheReadTokens: 0,
        },
      ],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });
    expect(started.accounts[0]?.canWarm).toBe(false);
  });

  it("says why a window's whole cannot be reckoned", () => {
    const runtime = runtimeOf();
    runtime.accountState.usage.set("p/a", {
      remaining: 990,
      limit: 1_000,
      usedPercent: 1,
      resetAt: NOW + 3_600_000,
      readAt: NOW,
    });
    const quota = snapshotGatewayQuota({
      providers: [provider()],
      runtime,
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });
    // Under 5% used: a rounded share that small is too coarse to scale up.
    expect(quota.accounts[0]?.windows[0]?.holdsWhy).toBe("low");
    expect(quota.accounts[0]?.windows[0]?.holds).toBeUndefined();
  });

  it("draws a plan as its own card, once, with no account behind it", () => {
    const runtime = runtimeOf();
    runtime.accountState.plans.set("volcengine:GetCodingPlanUsage:ak", {
      readAt: NOW,
      cards: [
        {
          id: "coding",
          plan: "Coding Plan",
          windows: [
            {
              id: "plan-session",
              name: "5 hours",
              usedPercent: 10,
              remaining: 90,
              limit: 100,
              resetsAt: NOW + 3_600_000,
              windowMs: 5 * 3_600_000,
            },
            {
              id: "plan-weekly",
              name: "Weekly",
              usedPercent: 40,
              remaining: null,
              limit: null,
              resetsAt: null,
              windowMs: 7 * 24 * 3_600_000,
            },
          ],
        },
      ],
    });
    const ark = {
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      accessKeyId: "ak",
      secretAccessKey: "sk",
    };
    const quota = snapshotGatewayQuota({
      providers: [
        provider({ id: "p1", ...ark }),
        provider({ id: "p2", accounts: [{ ...provider().accounts[0]!, id: "b" }], ...ark }),
      ],
      runtime,
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });

    expect(quota.accounts.map((account) => account.id)).toEqual(["p1/a", "p1/plan/coding", "p2/b"]);
    const plan = quota.accounts[1]!;
    expect(plan).toMatchObject({
      kind: "plan",
      providerId: "p1",
      planId: "coding",
      provider: "p1",
      account: "plan",
      accountLabel: "Coding Plan",
      canWarm: false,
      lastReadAt: NOW,
    });
    expect(plan.windows.map((window) => window.name)).toEqual(["5 hours", "Weekly"]);
    // The account keeps only its own windows; the plan is its own card.
    expect(quota.accounts[0]?.windows.some((window) => window.id.startsWith("plan-"))).toBe(false);
    // The same access key's plan is drawn once, not again on the other provider.
    expect(quota.accounts.some((card) => card.provider === "p2" && card.kind === "plan")).toBe(
      false,
    );
  });

  it("says a plan needs its access key, as myna's card does", () => {
    const runtime = runtimeOf();
    const quota = snapshotGatewayQuota({
      providers: [
        provider({
          id: "tencent",
          baseUrl: "https://tokenhub-intl.tencentmaas.com/plan/v3",
          accounts: [{ ...provider().accounts[0]!, id: "a" }],
          accessKeyId: undefined,
          secretAccessKey: undefined,
        }),
      ],
      runtime,
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });

    const plan = quota.accounts.find((card) => card.kind === "plan");
    expect(plan).toMatchObject({ kind: "plan", planId: "tencent:ap-singapore", windows: [] });
    expect(plan?.error).toContain("SecretId and SecretKey");
    expect(plan?.error).toContain("tencent's settings");
  });

  it("shows no access-key card for TokenHub's Guangzhou endpoint or a plan read elsewhere", () => {
    const runtime = runtimeOf();
    const guangzhou = provider({
      id: "guangzhou",
      baseUrl: "https://tokenhub.tencentmaas.com/plan/v3",
      accounts: [{ ...provider().accounts[0]!, id: "a" }],
      accessKeyId: undefined,
      secretAccessKey: undefined,
    });
    const keyless = provider({
      id: "volc",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      accounts: [{ ...provider().accounts[0]!, id: "a" }],
      accessKeyId: undefined,
      secretAccessKey: undefined,
    });
    const keyed = provider({
      id: "volc-reader",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      accessKeyId: "ak",
      secretAccessKey: "sk",
    });
    const quota = snapshotGatewayQuota({
      providers: [guangzhou, keyless, keyed],
      runtime,
      history: new Map(),
      usage: [],
      since: NOW - 7 * 24 * 3_600_000,
      now: NOW,
    });

    expect(quota.accounts.some((card) => card.kind === "plan")).toBe(false);
  });

  it("finds the account a warm-up names", () => {
    expect(findAccount([provider()], "p", "a")?.account.id).toBe("a");
    expect(findAccount([provider()], "p", "other")).toBeNull();
    expect(findAccount([provider({ enabled: false })], "p", "a")).toBeNull();
  });
});
