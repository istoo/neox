import { describe, expect, it } from "vitest";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import {
  accountAtUsageCap,
  autoIncludedModels,
  failureCounted,
  matchesAutoInclude,
  nextDailyResetAt,
  poolAtCap,
  queueHasRoom,
  quotaRestFor,
  restForFailure,
  spendCapReached,
  windowKeyOf,
} from "./provider-limits.js";

const provider = (overrides: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: "p",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  accounts: [],
  models: [],
  ...overrides,
});

const account = (overrides: Partial<GatewayAccount> = {}): GatewayAccount => ({
  id: "a",
  priority: 0,
  weight: 1,
  enabled: true,
  models: [],
  warmup: false,
  warmAt: "",
  ...overrides,
});

const now = 1_700_000_000_000;

describe("restForFailure", () => {
  it("rests a failure and a rate limit a minute, doubling with attempts, held at the cap", () => {
    // myna's fallbackCooldown, for a transport failure as for a 5xx
    expect(restForFailure({ status: null, provider: provider({}), now })).toBe(60_000);
    expect(restForFailure({ status: 502, provider: provider({}), now })).toBe(60_000);
    expect(restForFailure({ status: 429, provider: provider({}), now })).toBe(60_000);
    expect(restForFailure({ status: 429, attempt: 3, provider: provider({}), now })).toBe(240_000);
    expect(restForFailure({ status: 429, attempt: 20, provider: provider({}), now })).toBe(
      30 * 60_000,
    );
  });

  it("uses the provider's cap, and rests no key at 0 for a limit or an unknown failure", () => {
    expect(
      restForFailure({ status: 500, provider: provider({ restCapMs: 120_000 }), now, attempt: 9 }),
    ).toBe(120_000);
    expect(restForFailure({ status: null, provider: provider({ restCapMs: 0 }), now })).toBe(0);
    // myna's LimitRestOff: a rate limit or a spent allowance never rests the key
    expect(restForFailure({ status: 429, provider: provider({ restCapMs: 0 }), now })).toBe(0);
    expect(
      restForFailure({ status: 429, quota: true, provider: provider({ restCapMs: 0 }), now }),
    ).toBe(0);
    // a refused key is not an unknown failure: the backoff stays
    expect(restForFailure({ status: 401, provider: provider({ restCapMs: 0 }), now })).toBe(60_000);
  });

  it("does not set aside a failure that isn't the key's", () => {
    for (const kind of ["cut", "zdr", "offline", "policy", "openCodeBare", "proxy"] as const) {
      expect(restForFailure({ status: 400, provider: provider({}), now, kind })).toBe(0);
      expect(failureCounted(kind)).toBe(false);
    }
  });

  it("rests a restricted account and one to be verified a while", () => {
    expect(restForFailure({ status: 403, provider: provider({}), now, kind: "restricted" })).toBe(
      2 * 60 * 60_000,
    );
    expect(restForFailure({ status: 403, provider: provider({}), now, kind: "verify" })).toBe(
      30 * 60_000,
    );
  });

  it("rests a busy vendor a moment, as long as its Retry-After asks up to a minute", () => {
    expect(restForFailure({ status: 529, provider: provider({}), now, kind: "overloaded" })).toBe(
      30_000,
    );
    expect(
      restForFailure({
        status: 529,
        provider: provider({}),
        now,
        kind: "overloaded",
        retryAfterMs: 20_000,
      }),
    ).toBe(20_000);
    expect(
      restForFailure({
        status: 529,
        provider: provider({}),
        now,
        kind: "overloaded",
        retryAfterMs: 5 * 60_000,
      }),
    ).toBe(60_000);
    expect(failureCounted("overloaded")).toBe(false);
  });

  it("rests a key out of credit half an hour, or as long as the vendor asks", () => {
    expect(restForFailure({ status: 402, provider: provider({}), now, kind: "credit" })).toBe(
      30 * 60_000,
    );
    expect(
      restForFailure({
        status: 402,
        provider: provider({}),
        now,
        kind: "credit",
        retryAfterMs: 10 * 60_000,
      }),
    ).toBe(10 * 60_000);
    expect(
      restForFailure({
        status: 402,
        provider: provider({}),
        now,
        kind: "credit",
        retryAfterMs: 5 * 60 * 60_000,
      }),
    ).toBe(60 * 60_000);
    expect(
      restForFailure({ status: 402, provider: provider({ restCapMs: 0 }), now, kind: "credit" }),
    ).toBe(0);
    expect(failureCounted("credit")).toBe(true);
  });

  it("takes the vendor's Retry-After over a rate limit's backoff", () => {
    expect(restForFailure({ status: 429, provider: provider({}), now, retryAfterMs: 5_000 })).toBe(
      60_000,
    );
    expect(
      restForFailure({ status: 429, provider: provider({}), now, retryAfterMs: 10 * 60_000 }),
    ).toBe(10 * 60_000);
  });

  it("takes the vendor's reset over every cap", () => {
    expect(
      restForFailure({
        status: 429,
        provider: provider({ restCapMs: 1 }),
        now,
        vendorResetAt: now + 10 * 60_000,
      }),
    ).toBe(10 * 60_000);
  });
});

describe("quota rest", () => {
  it("is the gateway's quarter of an hour unless the provider says otherwise", () => {
    expect(quotaRestFor(provider({}), now)).toBe(15 * 60_000);
    expect(quotaRestFor(provider({ quotaRest: { seconds: 3600 } }), now)).toBe(3_600_000);
    expect(restForFailure({ status: 429, quota: true, provider: provider({}), now })).toBe(
      15 * 60_000,
    );
  });

  it("waits for the next time of day a daily allowance comes back", () => {
    const at = nextDailyResetAt("08:00", now);
    expect(at).not.toBeNull();
    expect((at ?? 0) - now).toBeGreaterThan(0);
    expect((at ?? 0) - now).toBeLessThanOrEqual(24 * 3_600_000);
    // the same clock time tomorrow once today's has passed
    const next = nextDailyResetAt("08:00", now);
    expect(nextDailyResetAt("08:00", (next ?? 0) + 1)).toBe((next ?? 0) + 86_400_000);
  });

  it("reads a fixed-offset clock as the vendor's", () => {
    expect(nextDailyResetAt("00:00+08:00", now)).not.toBeNull();
    expect(nextDailyResetAt("00:00Z", now)).not.toBeNull();
    expect(nextDailyResetAt("25:00", now)).toBeNull();
  });
});

describe("caps", () => {
  it("holds an account at the share of its window the user set", () => {
    expect(accountAtUsageCap(account({ capPercent: 70 }), { usedPercent: 70 })).toBe(true);
    expect(accountAtUsageCap(account({ capPercent: 70 }), { usedPercent: 69 })).toBe(false);
    expect(accountAtUsageCap(account({}), { usedPercent: 99 })).toBe(false);
    expect(accountAtUsageCap(account({ capPercent: 1 }), { usedPercent: null })).toBe(false);
  });

  it("holds an account at one window's own share", () => {
    const reading = {
      usedPercent: 10,
      windows: [
        { key: "5h", usedPercent: 55, resetsAt: null },
        { key: "7d", usedPercent: 20, resetsAt: null },
      ],
    };
    expect(accountAtUsageCap(account({ capPercent: 70 }), reading)).toBe(false);
    expect(
      accountAtUsageCap(account({ capPercent: 70, capWindows: { "5 hours": 50 } }), reading),
    ).toBe(true);
    expect(
      accountAtUsageCap(account({ capPercent: 70, capWindows: { "5 hours": 100 } }), reading),
    ).toBe(false);
  });

  it("gives a window with no share of its own the account's", () => {
    const reading = {
      usedPercent: null,
      windows: [{ key: "7d", usedPercent: 41, resetsAt: null }],
    };
    expect(accountAtUsageCap(account({ capPercent: 40 }), reading)).toBe(true);
    expect(accountAtUsageCap(account({ capPercent: 42 }), reading)).toBe(false);
  });

  it("holds an uncapped window at 100 when credits are off", () => {
    const reading = {
      usedPercent: null,
      windows: [{ key: "5h", usedPercent: 100, resetsAt: null }],
    };
    expect(accountAtUsageCap(account({ creditsMode: "off" }), reading)).toBe(true);
    expect(accountAtUsageCap(account({ creditsMode: "on" }), reading)).toBe(false);
  });

  it("matches one window by the names vendors and the CLI give it", () => {
    expect(windowKeyOf("5 Hours")).toBe("5h");
    expect(windowKeyOf("five_hour")).toBe("5h");
    expect(windowKeyOf("Weekly")).toBe("7d");
    expect(windowKeyOf("7 days")).toBe("7d");
    expect(windowKeyOf("7 days · opus")).toBe("7 days · opus");
  });

  it("holds a key at its spend cap", () => {
    expect(spendCapReached({ usd: 5 }, 5)).toBe(true);
    expect(spendCapReached({ usd: 5 }, 4.99)).toBe(false);
    expect(spendCapReached(undefined, 100)).toBe(false);
  });

  it("bounds a queue only when the provider gives it a length", () => {
    expect(queueHasRoom(undefined, 99)).toBe(true);
    expect(queueHasRoom(0, 99)).toBe(true);
    expect(queueHasRoom(2, 1)).toBe(true);
    expect(queueHasRoom(2, 2)).toBe(false);
  });

  it("ends a pool at its caps only when every account is held", () => {
    const accounts = [account({ id: "a" }), account({ id: "b" })];
    expect(poolAtCap(provider({ stopAtCap: true }), accounts, () => true)).toBe(true);
    expect(poolAtCap(provider({ stopAtCap: true }), accounts, (a) => a.id === "a")).toBe(false);
    expect(poolAtCap(provider({}), accounts, () => true)).toBe(false);
    expect(poolAtCap(provider({ stopAtCap: true }), [], () => true)).toBe(false);
  });
});

describe("auto include", () => {
  it("matches globs in any case and re: rules, whole ids", () => {
    expect(matchesAutoInclude(["gpt-*"], "GPT-6.1-sol")).toBe(true);
    expect(matchesAutoInclude(["*claude*"], "claude-opus-4-6")).toBe(true);
    expect(matchesAutoInclude(["gpt-*"], "o3")).toBe(false);
    expect(matchesAutoInclude(["re:^gpt-\\d"], "gpt-6")).toBe(true);
    expect(matchesAutoInclude(["re:^gpt-\\d"], "my-gpt-6")).toBe(false);
    // an id is not a rule
    expect(matchesAutoInclude(["gpt-6"], "gpt-6")).toBe(false);
  });

  it("takes newly listed matches only", () => {
    expect(
      autoIncludedModels(["claude-*"], ["claude-a", "gpt-6", "claude-b"], ["claude-a"]),
    ).toEqual(["claude-b"]);
  });
});
