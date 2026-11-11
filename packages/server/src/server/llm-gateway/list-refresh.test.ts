import pino from "pino";
import { describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import { ListRefreshScheduler } from "./list-refresh.js";

const logger = pino({ level: "silent" });

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return { id: "p", enabled: true, accounts: [], ...overrides } as GatewayProvider;
}

describe("ListRefreshScheduler", () => {
  it("fetches a due provider's list and takes its new models", async () => {
    let now = 1_000;
    const fetched: string[] = [];
    const taken: Array<[string, readonly string[]]> = [];
    const scheduler = new ListRefreshScheduler({
      providers: () => [provider({ refreshEveryMs: 60 * 60_000 })],
      fetchModels: async (entry) => {
        fetched.push(entry.id);
        return ["gpt-5"];
      },
      take: async (id, listed) => {
        taken.push([id, listed]);
        return ["gpt-5"];
      },
      logger,
      now: () => now,
    });
    await scheduler.tick();
    expect(fetched).toEqual(["p"]);
    expect(taken).toEqual([["p", ["gpt-5"]]]);
    now += 30 * 60_000;
    await scheduler.tick();
    expect(fetched).toHaveLength(1);
    now += 31 * 60_000;
    await scheduler.tick();
    expect(fetched).toHaveLength(2);
  });

  it("asks only a list that is due, by when it was last fetched", async () => {
    const now = 10 * 60 * 60_000;
    const fetched: string[] = [];
    const scheduler = new ListRefreshScheduler({
      providers: () => [
        provider({ id: "fresh", refreshEveryMs: 60 * 60_000, listFetchedAt: now - 60_000 }),
        provider({
          id: "stale",
          refreshEveryMs: 60 * 60_000,
          listFetchedAt: now - 2 * 60 * 60_000,
        }),
      ],
      fetchModels: async (entry) => {
        fetched.push(entry.id);
        return [];
      },
      take: async () => [],
      logger,
      now: () => now,
    });
    await scheduler.tick();
    expect(fetched).toEqual(["stale"]);
  });

  it("leaves a provider with no schedule, or switched off, alone", async () => {
    const fetched: string[] = [];
    const scheduler = new ListRefreshScheduler({
      providers: () => [
        provider({ id: "unscheduled" }),
        provider({ id: "off", refreshEveryMs: 60 * 60_000, enabled: false }),
      ],
      fetchModels: async (entry) => {
        fetched.push(entry.id);
        return [];
      },
      take: async () => [],
      logger,
    });
    await scheduler.tick();
    expect(fetched).toEqual([]);
  });

  it("leaves a provider whose list an account or decision API keeps alone", async () => {
    const fetched: string[] = [];
    const scheduler = new ListRefreshScheduler({
      providers: () => [
        provider({
          id: "pool",
          refreshEveryMs: 3_600_000,
          accounts: [{ id: "a" } as GatewayProvider["accounts"][number]],
        }),
        provider({ id: "decide", refreshEveryMs: 3_600_000, decide: "https://decide.test" }),
      ],
      fetchModels: async (entry) => {
        fetched.push(entry.id);
        return [];
      },
      take: async () => [],
      logger,
    });
    await scheduler.tick();
    expect(fetched).toEqual([]);
  });

  it("answers an ask now for a provider of the user's own, schedule or not", async () => {
    const now = 5_000;
    const fetched: string[] = [];
    const scheduler = new ListRefreshScheduler({
      providers: () => [
        provider({ id: "asked" }),
        provider({ id: "pool", accounts: [{ id: "a" } as GatewayProvider["accounts"][number]] }),
      ],
      fetchModels: async (entry) => {
        fetched.push(entry.id);
        return [];
      },
      take: async () => [],
      logger,
      now: () => now,
    });
    expect(await scheduler.refreshNow("asked")).toEqual(["asked"]);
    // naming one asks it even when an account keeps its list (myna's
    // RefreshLists, which `neolix sync` uses)
    expect(await scheduler.refreshNow("pool")).toEqual(["pool"]);
    expect(fetched).toEqual(["asked", "pool"]);
  });

  it("does not ask again while its retry wait holds", async () => {
    let now = 0;
    let calls = 0;
    const scheduler = new ListRefreshScheduler({
      providers: () => [provider({ refreshEveryMs: 60 * 60_000 })],
      fetchModels: async () => {
        calls += 1;
        throw new Error("the vendor refused");
      },
      take: async () => [],
      logger,
      now: () => now,
    });
    await scheduler.tick();
    now += 60_000;
    expect(await scheduler.refreshNow("p")).toEqual([]);
    expect(calls).toBe(1);
    now += 15 * 60_000;
    expect(await scheduler.refreshNow("p")).toEqual(["p"]);
    expect(calls).toBe(2);
  });

  it("asks no more often than ten minutes", async () => {
    let now = 0;
    let calls = 0;
    const scheduler = new ListRefreshScheduler({
      providers: () => [provider({ refreshEveryMs: 60_000 })],
      fetchModels: async () => {
        calls += 1;
        return [];
      },
      take: async () => [],
      logger,
      now: () => now,
    });
    await scheduler.tick();
    now += 5 * 60_000;
    await scheduler.tick();
    expect(calls).toBe(1);
    now += 6 * 60_000;
    await scheduler.tick();
    expect(calls).toBe(2);
  });

  it("waits a retry after a failed fetch", async () => {
    let now = 0;
    let calls = 0;
    const scheduler = new ListRefreshScheduler({
      providers: () => [provider({ refreshEveryMs: 60 * 60_000 })],
      fetchModels: async () => {
        calls += 1;
        throw new Error("the vendor refused");
      },
      take: async () => [],
      logger,
      now: () => now,
    });
    await scheduler.tick();
    expect(calls).toBe(1);
    now += 10 * 60_000;
    await scheduler.tick();
    expect(calls).toBe(1);
    now += 5 * 60_000;
    await scheduler.tick();
    expect(calls).toBe(2);
  });
});
