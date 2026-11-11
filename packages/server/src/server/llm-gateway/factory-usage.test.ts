import { describe, expect, it } from "vitest";
import { factoryUsageReading, factoryWhen, readFactoryLimits } from "./factory-usage.js";
import type { FactorySubscriptionAccount } from "./subscription-store.js";

const KEY = "fk-abcdefgh12345678";

function account(extra: Partial<FactorySubscriptionAccount> = {}): FactorySubscriptionAccount {
  return {
    agent: "factory",
    id: "factory:one",
    user: "one@example.test",
    plan: null,
    addedAt: 1,
    lapsed: null,
    key: KEY,
    orgId: "org-1",
    region: null,
    prem: null,
    ...extra,
  };
}

const ANSWER = {
  limits: {
    standard: {
      fiveHour: { usedPercent: 12, windowEnd: "2026-11-06T12:00:00Z" },
      weekly: { usedPercent: 40, windowEnd: 1_800_000_000_000 },
    },
    core: {
      fiveHour: { usedPercent: 150, windowEnd: 1_800_000_000_000 },
    },
  },
  extraUsageBalanceCents: 250,
  extraUsageAllowed: true,
};

describe("factoryWhen", () => {
  it("reads an ISO time or epoch milliseconds", () => {
    expect(factoryWhen("2026-11-06T12:00:00Z")).toBe(Date.parse("2026-11-06T12:00:00Z"));
    expect(factoryWhen(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(factoryWhen("nope")).toBeNull();
  });
});

describe("readFactoryLimits", () => {
  it("reads standard and Droid Core windows, and extra usage", async () => {
    let url = "";
    const fetchImpl = ((input: RequestInfo | URL) => {
      url = String(input);
      return Promise.resolve(
        new Response(JSON.stringify(ANSWER), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const limits = await readFactoryLimits({ account: account(), now: 9 }, { fetchImpl });

    expect(url).toBe("https://api.factory.ai/api/billing/limits");
    if ("error" in limits) {
      throw new Error(limits.error);
    }
    expect(limits.standard.map((window) => window.usedPercent)).toEqual([12, 40]);
    expect(limits.core).toEqual([{ usedPercent: 100, resetsAt: 1_800_000_000_000 }]);
    expect(limits.extraCents).toBe(250);
    expect(limits.readAt).toBe(9);
  });

  it("says what Factory answered when limits can't be read", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("no", { status: 500 }))) as typeof fetch;
    const limits = await readFactoryLimits({ account: account() }, { fetchImpl });
    expect("error" in limits && limits.error).toContain("500");
  });
});

describe("factoryUsageReading", () => {
  it("names standard and core windows for routing and the allowance cards", () => {
    const reading = factoryUsageReading({
      standard: [{ usedPercent: 10, resetsAt: 1 }],
      core: [{ usedPercent: 20, resetsAt: 2 }],
      extraCents: null,
      readAt: 3,
    });

    expect(reading.windows).toEqual([
      { key: "5h", usedPercent: 10, resetsAt: 1 },
      { key: "core-5h", usedPercent: 20, resetsAt: 2 },
    ]);
    expect(reading.readAt).toBe(3);
  });
});
