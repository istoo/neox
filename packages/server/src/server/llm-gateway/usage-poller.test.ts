import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountRoutingState, planAccounts } from "./accounts.js";
import type { GatewayProvider } from "./config.js";
import { RestTable } from "./routing.js";
import {
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  type FactorySubscriptionAccount,
} from "./subscription-store.js";
import { readUsage, UsagePoller } from "./usage-poller.js";

describe("readUsage", () => {
  it("reads remaining, limit and a millisecond reset", () => {
    const now = Date.now();
    const reading = readUsage({ remaining: 25, limit: 100, resetAt: now + 60_000 }, now);
    expect(reading).toMatchObject({
      remaining: 25,
      limit: 100,
      usedPercent: 75,
      resetAt: now + 60_000,
    });
  });

  it("reads the snake_case spellings and a relative reset", () => {
    const now = 0;
    const reading = readUsage({ remaining_tokens: 0, total: 10, reset_at: 120 }, now);
    expect(reading).toMatchObject({ remaining: 0, limit: 10, usedPercent: 100, resetAt: 120_000 });
  });

  it("ignores a body without any numbers", () => {
    expect(readUsage({ message: "ok" }, 0)).toBeNull();
  });

  it("reads each usage window a vendor reports", () => {
    const now = 1_700_000_000_000;
    const reading = readUsage(
      {
        windows: [
          { name: "5 hours", used_percent: 55, resets_at: now + 60_000 },
          { key: "7d", used: 20, limit: 100 },
          { key: "weekly", utilization: 41 },
        ],
      },
      now,
    );
    expect(reading).toEqual({
      remaining: null,
      limit: null,
      usedPercent: null,
      resetAt: null,
      readAt: now,
      windows: [
        { key: "5 hours", usedPercent: 55, resetsAt: now + 60_000 },
        { key: "7d", usedPercent: 20, resetsAt: null },
        { key: "weekly", usedPercent: 41, resetsAt: null },
      ],
    });
  });

  it("drops a window it cannot name", () => {
    const reading = readUsage(
      { windows: [{ used_percent: 50 }, { key: "7d", used_percent: 10 }] },
      0,
    );
    expect(reading?.windows).toEqual([{ key: "7d", usedPercent: 10, resetsAt: null }]);
  });
});

describe("accounts with an external usage reading", () => {
  it("moves an account with nothing left behind the others", () => {
    const pool: GatewayProvider = {
      id: "p",
      protocol: "anthropic",
      baseUrl: "https://example.test/v1",
      accounts: [
        { id: "a0", priority: 0, weight: 1, enabled: true, models: [] },
        { id: "a1", priority: 0, weight: 1, enabled: true, models: [] },
      ],
      models: [{ id: "m" }],
      maxAccounts: undefined,
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
    };
    const state = createAccountRoutingState(new RestTable());
    state.usage.set("p/a0", {
      remaining: 0,
      limit: 100,
      usedPercent: 100,
      resetAt: null,
      readAt: 0,
    });
    const accounts = planAccounts({ provider: pool, state, now: 0, modelId: "m" });
    expect(accounts.map((account) => account.id)).toEqual(["a1", "a0"]);
  });
});

describe("UsagePoller", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads a Factory account's limits through its key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neolix-usage-factory-"));
    const factory: FactorySubscriptionAccount = {
      agent: "factory",
      id: "factory:one",
      user: "one@example.test",
      plan: null,
      addedAt: 1,
      lapsed: null,
      key: "fk-abcdefgh12345678",
      orgId: "org-1",
      region: null,
      prem: null,
    };
    await saveSubscriptionAccounts(subscriptionAccountsFile(dir, "factory"), [factory]);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ limits: { standard: { fiveHour: { usedPercent: 12 } } } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider: GatewayProvider = {
      id: "p",
      protocol: "anthropic",
      baseUrl: "https://example.test/v1",
      accounts: [
        {
          id: "a",
          priority: 0,
          weight: 1,
          warmup: false,
          models: [],
          enabled: true,
          agent: "factory",
          subscriptionUser: "one@example.test",
        },
      ],
      models: [{ id: "m" }],
    } as unknown as GatewayProvider;
    const state = createAccountRoutingState(new RestTable());
    const poller = new UsagePoller({
      state,
      providers: () => [provider],
      logger: pino({ level: "silent" }),
      gatewayDir: dir,
    });

    try {
      await poller.refreshAll(5);
      expect(state.usage.get("p/a")?.windows).toEqual([
        { key: "5h", usedPercent: 12, resetsAt: null },
      ]);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://api.factory.ai/api/billing/limits",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops polling once disposed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ remaining: 1, limit: 2 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider: GatewayProvider = {
      id: "p",
      protocol: "anthropic",
      baseUrl: "https://example.test/v1",
      accounts: [
        {
          id: "a",
          priority: 0,
          weight: 1,
          warmup: false,
          models: [],
          enabled: true,
          usageUrl: "https://example.test/usage",
        },
      ],
      models: [{ id: "m" }],
      maxAccounts: undefined,
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
    };
    const poller = new UsagePoller({
      state: createAccountRoutingState(new RestTable()),
      providers: () => [provider],
      logger: pino({ level: "silent" }),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const polls = fetchMock.mock.calls.length;
    expect(polls).toBeGreaterThan(0);

    poller.dispose();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(polls);
  });
});

describe("UsagePoller and myna's quotaReads", () => {
  const provider = (): GatewayProvider =>
    ({
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
          usageUrl: "https://vendor.test/usage",
        },
      ],
      models: [{ id: "m" }],
      queueWaitMs: 0,
      priceRate: 1,
    }) as unknown as GatewayProvider;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads nothing on the timer when quotaReads is "asked"', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ remaining: 5, limit: 10 }), { status: 200 });
      }),
    );
    const state = createAccountRoutingState(new RestTable());
    const poller = new UsagePoller({
      state,
      providers: () => [provider()],
      logger: pino({ level: "silent" }),
      readsAsked: () => true,
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toEqual([]);
    await poller.refreshAll(1_000);
    poller.dispose();
    expect(requests).toEqual(["https://vendor.test/usage"]);
    expect(state.usage.get("p/a")).toMatchObject({ usedPercent: 50 });
  });

  it("keeps the timer's reads when they are automatic", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ remaining: 1, limit: 10 }), { status: 200 });
      }),
    );
    const state = createAccountRoutingState(new RestTable());
    const poller = new UsagePoller({
      state,
      providers: () => [provider()],
      logger: pino({ level: "silent" }),
      readsAsked: () => false,
    });
    poller.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    poller.dispose();
  });
});

describe("UsagePoller refresh under quotaReads asked", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves the kept reading when a careful cap asks for one", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ remaining: 1, limit: 10 }), { status: 200 });
      }),
    );
    const gateway = providerWithUsageUrl();
    const state = createAccountRoutingState(new RestTable());
    const poller = new UsagePoller({
      state,
      providers: () => [gateway],
      logger: pino({ level: "silent" }),
      readsAsked: () => true,
    });
    await poller.refresh(gateway, gateway.accounts[0]!, 1_000);
    expect(requests).toEqual([]);
    expect(state.usage.get("p/a")).toBeUndefined();
  });
});

describe("UsagePoller and a plan's control plane", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a plan once per access key and keeps it for routing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({
            ResponseMetadata: {},
            Result: {
              QuotaUsage: [{ Level: "session", Percent: 40, ResetTimestamp: 1_800_000_000 }],
            },
          }),
          { status: 200 },
        );
      }),
    );
    const ark = (id: string): GatewayProvider =>
      ({
        id,
        protocol: "openai",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        accessKeyId: "ak",
        secretAccessKey: "sk",
        accounts: [{ id: "a", priority: 0, weight: 1, enabled: true, models: [], apiKey: "key" }],
        models: [{ id: "m" }],
        queueWaitMs: 0,
        priceRate: 1,
      }) as unknown as GatewayProvider;
    const state = createAccountRoutingState(new RestTable());
    const poller = new UsagePoller({
      state,
      providers: () => [ark("p1"), ark("p2")],
      logger: pino({ level: "silent" }),
    });

    await poller.refreshAll(1_000_000);

    expect(calls).toHaveLength(1);
    expect(state.plans.get("volcengine:GetCodingPlanUsage:ak")?.cards[0]?.windows[0]).toMatchObject(
      {
        id: "plan-session",
        usedPercent: 40,
        resetsAt: 1_800_000_000_000,
      },
    );
  });

  it("reads the plan when the user asks, even under quotaReads asked", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );
    const provider = {
      id: "p",
      protocol: "openai",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      accounts: [{ id: "a", priority: 0, weight: 1, enabled: true, models: [], apiKey: "key" }],
      models: [],
      queueWaitMs: 0,
      priceRate: 1,
    } as unknown as GatewayProvider;
    const poller = new UsagePoller({
      state: createAccountRoutingState(new RestTable()),
      providers: () => [provider],
      logger: pino({ level: "silent" }),
      readsAsked: () => true,
    });

    await poller.refreshAll(1_000_000);

    expect(calls).toHaveLength(1);
  });
});

function providerWithUsageUrl(): GatewayProvider {
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
        usageUrl: "https://vendor.test/usage",
      },
    ],
    models: [{ id: "m" }],
    queueWaitMs: 0,
    priceRate: 1,
  } as unknown as GatewayProvider;
}
