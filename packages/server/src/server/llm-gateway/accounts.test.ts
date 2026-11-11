import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountKey,
  accountSpendWithin,
  acquireAccount,
  addAccountSpend,
  createAccountRoutingState,
  planAccounts,
  providerAtCap,
  releaseAccount,
  waitForFreeAccount,
} from "./accounts.js";
import { clearCodexLimits, noteCodexLimits } from "./codex-limits.js";
import type { GatewayProvider } from "./config.js";
import { RestTable } from "./routing.js";

function provider(accounts: Array<Partial<GatewayProvider["accounts"][number]>>): GatewayProvider {
  return {
    id: "p",
    protocol: "anthropic",
    baseUrl: "https://example.test/v1",
    accounts: accounts.map((account, index) => ({
      id: account.id ?? `a${index}`,
      priority: account.priority ?? 0,
      weight: account.weight ?? 1,
      enabled: account.enabled ?? true,
      models: account.models ?? [],
      maxConcurrency: account.maxConcurrency,
      maxRpm: account.maxRpm,
      monthlyUsd: account.monthlyUsd,
      capPercent: account.capPercent,
      capWindows: account.capWindows,
      creditsMode: account.creditsMode,
      agent: account.agent,
      codexAccountId: account.codexAccountId,
      spendCap: account.spendCap,
    })),
    models: [],
  };
}

describe("switchOnly", () => {
  it("leaves the agent's own sign-ins out of routing, and serves keys still", () => {
    const pool = provider([
      { id: "own", agent: "claude-code" },
      { id: "codex-own", codexAccountId: "neolix:acc" },
      { id: "key" },
    ]);
    pool.switchOnly = true;
    const state = createAccountRoutingState(new RestTable());
    expect(planAccounts({ provider: pool, state, now: 0 }).map((account) => account.id)).toEqual([
      "key",
    ]);
  });

  it("routes them as before while switchOnly is off", () => {
    const pool = provider([{ id: "own", agent: "claude-code" }, { id: "key" }]);
    const state = createAccountRoutingState(new RestTable());
    expect(planAccounts({ provider: pool, state, now: 0 }).map((account) => account.id)).toEqual([
      "own",
      "key",
    ]);
  });
});

describe("planAccounts", () => {
  it("uses the provider apiKey as the only implicit account", () => {
    const implicit: GatewayProvider = {
      id: "p",
      protocol: "anthropic",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      accounts: [],
      models: [],
    };
    const accounts = planAccounts({
      provider: implicit,
      state: createAccountRoutingState(new RestTable()),
      now: 0,
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: "default", apiKey: "secret" });
  });

  it("drops disabled accounts", () => {
    const accounts = planAccounts({
      provider: provider([{ id: "on" }, { id: "off", enabled: false }]),
      state: createAccountRoutingState(new RestTable()),
      now: 0,
    });
    expect(accounts.map((account) => account.id)).toEqual(["on"]);
  });

  it("finishes a higher priority tier before touching a lower one", () => {
    const accounts = planAccounts({
      provider: provider([
        { id: "low", priority: 0 },
        { id: "high", priority: 10 },
      ]),
      state: createAccountRoutingState(new RestTable()),
      now: 0,
    });
    expect(accounts.map((account) => account.id)).toEqual(["high", "low"]);
  });

  it("gives a heavier account a larger share of the traffic", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([
      { id: "heavy", weight: 3 },
      { id: "light", weight: 1 },
    ]);
    const seen: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const picked = planAccounts({ provider: pool, state, now: index })[0];
      seen.push(picked?.id ?? "none");
    }
    expect(seen.filter((id) => id === "heavy")).toHaveLength(6);
    expect(seen.filter((id) => id === "light")).toHaveLength(2);
  });

  it("moves a resting account behind the awake ones", () => {
    const state = createAccountRoutingState(new RestTable());
    state.rest.rest("p/a0", 60_000, 0);
    const accounts = planAccounts({
      provider: provider([{ id: "a0" }, { id: "a1" }]),
      state,
      now: 1000,
    });
    expect(accounts.map((account) => account.id)).toEqual(["a1", "a0"]);
  });

  it("moves a full account behind the one with room", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "a0", maxConcurrency: 1 }, { id: "a1" }]);
    acquireAccount(state, pool, pool.accounts[0]!);
    const accounts = planAccounts({ provider: pool, state, now: 0 });
    expect(accounts.map((account) => account.id)).toEqual(["a1", "a0"]);
    releaseAccount(state, pool, pool.accounts[0]!);
    expect(planAccounts({ provider: pool, state, now: 1 }).map((a) => a.id)).toContain("a0");
  });

  it("hides an account that does not serve the model", () => {
    const pool = provider([{ id: "broad" }, { id: "narrow", models: ["other"] }]);
    const accounts = planAccounts({
      provider: pool,
      state: createAccountRoutingState(new RestTable()),
      now: 0,
      modelId: "m",
    });
    expect(accounts.map((account) => account.id)).toEqual(["broad"]);
  });

  it("skips an account that reached its rpm", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "limited", maxRpm: 1 }, { id: "open" }]);
    acquireAccount(state, pool, pool.accounts[0]!);
    const accounts = planAccounts({ provider: pool, state, now: Date.now(), modelId: "m" });
    expect(accounts.map((account) => account.id)).toEqual(["open", "limited"]);
  });

  it("skips an account over its monthly spend cap", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "capped", monthlyUsd: 1 }, { id: "open" }]);
    addAccountSpend(state, pool, pool.accounts[0]!, 2, Date.now());
    const accounts = planAccounts({ provider: pool, state, now: Date.now(), modelId: "m" });
    expect(accounts.map((account) => account.id)).toEqual(["open", "capped"]);
  });

  it("keys rest and concurrency by provider/account", () => {
    const pool = provider([{ id: "a0" }]);
    const account = pool.accounts[0]!;
    expect(accountKey(pool, account)).toBe("p/a0");
  });
});

describe("caps and queues", () => {
  afterEach(() => {
    clearCodexLimits();
  });

  it("holds a Codex account at a window's own share from its own backend", () => {
    noteCodexLimits("codex-acc", [
      { windowMinutes: 300, usedPercent: 55, resetAt: null },
      { windowMinutes: 10_080, usedPercent: 20, resetAt: null },
    ]);
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([
      { id: "capped", codexAccountId: "codex-acc", capPercent: 70, capWindows: { "5 hours": 50 } },
      { id: "open" },
    ]);
    expect(planAccounts({ provider: pool, state, now: 0 }).map((a) => a.id)).toEqual([
      "open",
      "capped",
    ]);
  });

  it("moves an account held at its usage share behind a free one", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "capped", capPercent: 70 }, { id: "open" }]);
    state.usage.set("p/capped", {
      remaining: 50,
      limit: 100,
      usedPercent: 70,
      resetAt: null,
      readAt: 0,
    });
    expect(planAccounts({ provider: pool, state, now: 0 }).map((a) => a.id)).toEqual([
      "open",
      "capped",
    ]);
  });

  it("counts a day's spend and holds the key at its cap", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "capped", spendCap: { usd: 1, period: "day" } }, { id: "open" }]);
    const now = Date.now();
    addAccountSpend(state, pool, pool.accounts[0]!, 1, now);
    expect(accountSpendWithin(state, pool, pool.accounts[0]!, "day", now)).toBe(1);
    expect(planAccounts({ provider: pool, state, now }).map((a) => a.id)).toEqual([
      "open",
      "capped",
    ]);
  });

  it("holds an account set not to spend its credits once a window is used up", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "spent", creditsMode: "off" }, { id: "open" }]);
    state.usage.set("p/spent", {
      remaining: 0,
      limit: 100,
      usedPercent: 100,
      resetAt: null,
      readAt: 0,
    });
    expect(planAccounts({ provider: pool, state, now: 0 }).map((a) => a.id)).toEqual(["open"]);
  });

  it("holds a lone account set not to spend its credits", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "only", creditsMode: "off" }]);
    state.usage.set("p/only", {
      remaining: 0,
      limit: 100,
      usedPercent: 100,
      resetAt: null,
      readAt: 0,
    });
    expect(planAccounts({ provider: pool, state, now: 0 })).toEqual([]);
  });

  it("keeps an account that spends its credits first in place", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "spent", creditsMode: "first" }, { id: "open" }]);
    state.usage.set("p/spent", {
      remaining: 0,
      limit: 100,
      usedPercent: 100,
      resetAt: null,
      readAt: 0,
    });
    expect(planAccounts({ provider: pool, state, now: 0 }).map((a) => a.id)).toEqual([
      "spent",
      "open",
    ]);
  });

  it("moves an account that spends its credits last behind the others", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool = provider([{ id: "spent", creditsMode: "last" }, { id: "open" }]);
    state.usage.set("p/spent", {
      remaining: 0,
      limit: 100,
      usedPercent: 100,
      resetAt: null,
      readAt: 0,
    });
    expect(planAccounts({ provider: pool, state, now: 0 }).map((a) => a.id)).toEqual([
      "open",
      "spent",
    ]);
  });

  it("ends a pool at its caps when every account is held", () => {
    const state = createAccountRoutingState(new RestTable());
    const pool: GatewayProvider = {
      ...provider([
        { id: "a", spendCap: { usd: 1, period: "month" } },
        { id: "b", capPercent: 50 },
      ]),
      stopAtCap: true,
    };
    const now = Date.now();
    addAccountSpend(state, pool, pool.accounts[0]!, 2, now);
    state.usage.set("p/b", {
      remaining: 10,
      limit: 100,
      usedPercent: 90,
      resetAt: null,
      readAt: now,
    });
    expect(providerAtCap(state, pool, now, undefined)).toBe(true);
    state.usage.delete("p/b");
    expect(providerAtCap(state, pool, now, undefined)).toBe(false);
  });

  it("turns away a request when the queue is full", async () => {
    const state = createAccountRoutingState(new RestTable());
    const pool: GatewayProvider = { ...provider([{ id: "a" }]), queueLength: 1 };
    const account = pool.accounts[0]!;
    const first = waitForFreeAccount(state, 1_000, { provider: pool, account });
    expect(await waitForFreeAccount(state, 1_000, { provider: pool, account })).toBe(false);
    releaseAccount(state, pool, account);
    expect(await first).toBe(true);
  });

  it("wakes a queued request when the last slot frees, not at its timeout", async () => {
    vi.useFakeTimers();
    try {
      const state = createAccountRoutingState(new RestTable());
      const pool = provider([{ id: "a" }]);
      const account = pool.accounts[0]!;
      acquireAccount(state, pool, account);
      let woke = false;
      const waiting = waitForFreeAccount(state, 60_000, { provider: pool, account }).then(() => {
        woke = true;
        return undefined;
      });
      releaseAccount(state, pool, account);
      // Only microtasks run: the timeout is still a minute away.
      await vi.advanceTimersByTimeAsync(0);
      expect(woke).toBe(true);
      await waiting;
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an account's month in local time, like its day", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const state = createAccountRoutingState(new RestTable());
      const pool = provider([{ id: "a" }]);
      const account = pool.accounts[0]!;
      // 15:00 Dec 31 in New York, already Jan 1 in UTC.
      const recordedAt = Date.parse("2025-12-31T20:00:00Z");
      const now = Date.parse("2026-01-01T03:00:00Z");
      addAccountSpend(state, pool, account, 2, recordedAt);

      expect(accountSpendWithin(state, pool, account, "month", now)).toBe(2);
      expect(accountSpendWithin(state, pool, account, "day", now)).toBe(2);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
