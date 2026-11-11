import { describe, expect, it } from "vitest";
import type { GatewayConfig, GatewayProvider } from "./config.js";
import { nextSignIn, providerKeptToAgent, signInSpent } from "./switch-only.js";
import { createAccountRoutingState, planAccounts } from "./accounts.js";
import { RestTable } from "./routing.js";

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.test",
    accounts: [
      {
        id: "own",
        agent: "claude-code",
        priority: 0,
        weight: 1,
        enabled: true,
        models: [],
        warmup: false,
        warmAt: "",
      },
    ],
    models: [],
    ...overrides,
  } as GatewayProvider;
}

const limits = (usedPercent: number, resetAt: number | null = null) => [{ usedPercent, resetAt }];

describe("providerKeptToAgent", () => {
  it("keeps a switch-only Claude subscription from serving at all", () => {
    const kept = provider({ switchOnly: true });
    expect(providerKeptToAgent(kept)).toBe(true);
    const state = createAccountRoutingState(new RestTable());
    expect(planAccounts({ provider: kept, state, now: 0 })).toEqual([]);
  });

  it("serves it again with switch-only off, or on another provider", () => {
    const state = createAccountRoutingState(new RestTable());
    expect(planAccounts({ provider: provider(), state, now: 0 })).toHaveLength(1);
    expect(providerKeptToAgent(provider({ id: "codex", switchOnly: true }))).toBe(false);
  });
});

describe("nextSignIn", () => {
  const accounts = [{ id: "a" }, { id: "b" }, { id: "off", disabled: true }, { id: "c" }];

  it("moves on only once the account Codex is on is spent", () => {
    expect(
      nextSignIn({
        activeId: "a",
        accounts,
        limitsOf: (id) => (id === "a" ? limits(50) : limits(0)),
        now: 0,
      }),
    ).toBeNull();
  });

  it("takes the first account after it with room, skipping a disabled one", () => {
    const used = (id: string) => {
      if (id === "a") return limits(99);
      if (id === "b") return limits(100);
      return limits(10);
    };
    expect(
      nextSignIn({
        activeId: "a",
        accounts,
        limitsOf: used,
        now: 0,
      }),
    ).toBe("c");
  });

  it("says nothing when every later account is spent too", () => {
    expect(
      nextSignIn({
        activeId: "a",
        accounts: [{ id: "a" }, { id: "b" }],
        limitsOf: () => limits(100),
        now: 0,
      }),
    ).toBeNull();
  });

  it("counts a reset window as room again", () => {
    expect(signInSpent(limits(100, 5), 10)).toBe(false);
    expect(signInSpent(limits(100, 15), 10)).toBe(true);
  });
});

describe("config type", () => {
  it("carries switchOnly as an optional provider field", () => {
    const config = { providers: [provider({ switchOnly: true })] } as unknown as GatewayConfig;
    expect(config.providers[0]?.switchOnly).toBe(true);
  });
});
