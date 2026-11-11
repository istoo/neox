import { describe, expect, it } from "vitest";
import { createAccountRoutingState, accountKey } from "./accounts.js";
import {
  CAREFUL_FRESH_MS,
  CAREFUL_OLD_MS,
  carefulDoubt,
  carefulHeldAccounts,
  forgetCarefulTries,
  readCareful,
} from "./cap-careful.js";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import { RestTable } from "./routing.js";

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "fake",
    protocol: "openai-responses",
    baseUrl: "https://up.example/v1",
    accounts: [],
    countFree: false,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    models: [],
    replyHeaders: [],
    passHeaders: [],
    ...overrides,
  } as GatewayProvider;
}

function account(overrides: Partial<GatewayAccount> = {}): GatewayAccount {
  return {
    id: "a",
    enabled: true,
    priority: 0,
    weight: 1,
    models: [],
    ...overrides,
  } as GatewayAccount;
}

const NOW = 10_000_000;

function state(reading?: { usedPercent: number; readAt: number }) {
  const routing = createAccountRoutingState(new RestTable());
  if (reading !== undefined) {
    routing.usage.set("fake/a", {
      remaining: null,
      limit: null,
      usedPercent: reading.usedPercent,
      resetAt: null,
      readAt: reading.readAt,
    });
  }
  return routing;
}

describe("carefulDoubt", () => {
  const careful = provider({ capCareful: true });

  it("holds an account that was never read", () => {
    expect(
      carefulDoubt(careful, account({ usageUrl: "https://up.example/usage" }), state(), NOW),
    ).toContain("hasn't been read");
  });

  it("holds an account whose reading is over five minutes old", () => {
    const reading = { usedPercent: 10, readAt: NOW - CAREFUL_OLD_MS - 1 };
    expect(
      carefulDoubt(careful, account({ usageUrl: "https://up.example/usage" }), state(reading), NOW),
    ).toContain("was last read");
  });

  it("holds a near-cap account whose reading is over fifteen seconds old", () => {
    const near = { usedPercent: 97, readAt: NOW - CAREFUL_FRESH_MS - 1 };
    expect(
      carefulDoubt(careful, account({ usageUrl: "https://up.example/usage" }), state(near), NOW),
    ).toContain("near its cap");
    const fresh = { usedPercent: 97, readAt: NOW - 1_000 };
    expect(
      carefulDoubt(careful, account({ usageUrl: "https://up.example/usage" }), state(fresh), NOW),
    ).toBeNull();
  });

  it("leaves a provider that isn't careful, or an account with no cap, alone", () => {
    expect(
      carefulDoubt(provider(), account({ usageUrl: "https://up.example/usage" }), state(), NOW),
    ).toBeNull();
    expect(carefulDoubt(careful, account(), state(), NOW)).toBeNull();
  });
});

describe("carefulHeldAccounts", () => {
  it("names the accounts a request must leave alone", () => {
    const stateNow = state();
    const providers = [
      provider({ capCareful: true, accounts: [account({ usageUrl: "https://up.example/usage" })] }),
      provider({
        id: "other",
        accounts: [account({ id: "b", usageUrl: "https://up.example/usage" })],
      }),
    ];
    expect([...carefulHeldAccounts(providers, stateNow, NOW)]).toEqual([
      accountKey(providers[0]!, account()),
    ]);
  });
});

describe("readCareful", () => {
  it("refreshes doubtful accounts, at most once per retry window", async () => {
    forgetCarefulTries();
    const providers = [
      provider({ capCareful: true, accounts: [account({ usageUrl: "https://up.example/usage" })] }),
    ];
    const stateNow = state();
    const refreshed: string[] = [];
    await readCareful(
      providers,
      stateNow,
      async (p, a) => {
        refreshed.push(accountKey(p, a));
      },
      NOW,
    );
    expect(refreshed).toEqual(["fake/a"]);
    await readCareful(
      providers,
      stateNow,
      async (p, a) => {
        refreshed.push(accountKey(p, a));
      },
      NOW + 1_000,
    );
    expect(refreshed).toEqual(["fake/a"]);
    forgetCarefulTries();
  });
});
