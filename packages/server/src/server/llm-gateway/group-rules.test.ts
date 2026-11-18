import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config.js";
import type { GatewayRuleContext } from "./group-rules.js";
import type { RoutingState } from "./routing.js";

const classifyTurn = vi.hoisted(() => vi.fn(async () => ({ intent: "code", effort: "high" })));
vi.mock("./classifier.js", () => ({ classifyTurn }));

import { planRequestCandidates } from "./group-rules.js";

function configWith(classifyTimeout?: number): GatewayConfig {
  return {
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        models: [{ id: "claude-sonnet-5-5" }],
      },
    ],
    groups: [
      {
        id: "daily",
        members: ["anthropic/claude-sonnet-5-5"],
        classifier: "anthropic/claude-sonnet-5-5",
        rules: [{ intent: "code", use: "anthropic/claude-sonnet-5-5" }],
      },
    ],
    ...(classifyTimeout === undefined ? {} : { classifyTimeout }),
  };
}

const state: RoutingState = {
  rest: { get: () => undefined } as unknown as RoutingState["rest"],
  rotationCursors: new Map(),
  usageCounts: new Map(),
  sticky: new Map(),
  lastUsed: new Map(),
};

const context: GatewayRuleContext = {
  agent: "claude",
  tokens: 100,
  images: false,
  effort: null,
  reasoning: false,
  folder: null,
  compact: false,
  text: "fix the failing test",
  now: Date.parse("2026-03-04T05:00:00.000Z"),
};

function ask(config: GatewayConfig) {
  return planRequestCandidates({
    config,
    requestedModel: "group/daily",
    state,
    context,
    classify: async () => ({ content: [{ type: "text", text: "code" }] }),
  });
}

describe("planRequestCandidates", () => {
  beforeEach(() => {
    classifyTurn.mockClear();
  });

  it("gives the intent classifier the configured timeout", async () => {
    await ask(configWith(15));
    expect(classifyTurn).toHaveBeenCalledTimes(1);
    expect(classifyTurn.mock.calls[0]?.[0]).toMatchObject({
      intents: ["code"],
      effort: false,
      timeoutMs: 15_000,
    });
  });

  it("leaves the classifier at its own 8 seconds when no timeout is set", async () => {
    await ask(configWith());
    expect(classifyTurn).toHaveBeenCalledTimes(1);
    const called = classifyTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("timeoutMs" in called).toBe(false);
  });
});

function twoModels(): GatewayConfig {
  return {
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "p",
        protocol: "openai",
        baseUrl: "https://p.test/v1",
        models: [{ id: "a" }, { id: "b" }],
      },
    ],
    groups: [],
  };
}

describe("match patterns", () => {
  it("adds the models the patterns find after the ones it names", async () => {
    const config: GatewayConfig = {
      ...twoModels(),
      groups: [{ id: "g", members: ["p/a"], match: ["p/*"] }],
    };
    const planned = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state,
      context,
    });
    expect(planned.candidates.map((candidate) => candidate.model.id)).toEqual(["a", "b"]);
  });
});

describe("manual groups", () => {
  it("sends every request to the pick alone, and the rules wait", async () => {
    const config: GatewayConfig = {
      ...twoModels(),
      groups: [
        {
          id: "g",
          members: ["p/a", "p/b"],
          manual: true,
          pick: "p/b",
          rules: [{ use: "p/a", tokens: 1 }],
        },
      ],
    };
    const planned = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state,
      context: { ...context, tokens: 10_000 },
      classify: async () => undefined,
    });
    expect(planned.candidates.map((candidate) => candidate.model.id)).toEqual(["b"]);
    expect(planned.rule).toBeNull();
  });

  it("falls back to the first member when none is picked", async () => {
    const config: GatewayConfig = {
      ...twoModels(),
      groups: [{ id: "g", members: ["p/a", "p/b"], manual: true }],
    };
    const planned = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state,
      context,
    });
    expect(planned.candidates.map((candidate) => candidate.model.id)).toEqual(["a"]);
  });
});

describe("effort=auto", () => {
  beforeEach(() => {
    classifyTurn.mockClear();
  });

  function config(): GatewayConfig {
    return {
      ...twoModels(),
      groups: [
        {
          id: "g",
          members: ["p/a", "p/b"],
          classifier: "p/a",
          effort: "auto",
        },
      ],
    };
  }

  it("asks the classifier for the turn's reasoning when the agent asked to reason", async () => {
    const planned = await planRequestCandidates({
      config: config(),
      requestedModel: "group/g",
      state,
      context: { ...context, reasoning: true, effort: "low", text: "design the new router" },
      classify: async () => undefined,
    });
    expect(classifyTurn).toHaveBeenCalledTimes(1);
    expect(classifyTurn.mock.calls[0]?.[0]).toMatchObject({ intents: [], effort: true });
    expect(planned.candidates.map((candidate) => candidate.ruleEffort)).toEqual(["high", "high"]);
  });

  it("leaves the agent's own level when it asked no reasoning", async () => {
    const planned = await planRequestCandidates({
      config: config(),
      requestedModel: "group/g",
      state,
      context: { ...context, reasoning: false, effort: null },
      classify: async () => undefined,
    });
    expect(classifyTurn).not.toHaveBeenCalled();
    expect(planned.candidates.map((candidate) => candidate.ruleEffort)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("asks once when intent rules and effort=auto are both there", async () => {
    const both: GatewayConfig = {
      ...twoModels(),
      groups: [
        {
          id: "g",
          members: ["p/a", "p/b"],
          classifier: "p/a",
          effort: "auto",
          rules: [{ intent: "code", use: "p/b" }],
        },
      ],
    };
    const planned = await planRequestCandidates({
      config: both,
      requestedModel: "group/g",
      state,
      context: { ...context, reasoning: true, effort: "low" },
      classify: async () => undefined,
    });
    expect(classifyTurn).toHaveBeenCalledTimes(1);
    expect(classifyTurn.mock.calls[0]?.[0]).toMatchObject({
      intents: ["code"],
      effort: true,
    });
    expect(planned.rule?.use).toBe("p/b");
    expect(planned.candidates.map((candidate) => candidate.model.id)).toEqual(["b", "a"]);
    expect(planned.candidates.map((candidate) => candidate.ruleEffort)).toEqual(["high", "high"]);
  });

  it("lets a manual group's pick reason at the classifier's level", async () => {
    const byHand: GatewayConfig = {
      ...twoModels(),
      groups: [
        {
          id: "g",
          members: ["p/a", "p/b"],
          classifier: "p/a",
          effort: "auto",
          manual: true,
          pick: "p/b",
          rules: [{ intent: "code", use: "p/a" }],
        },
      ],
    };
    const planned = await planRequestCandidates({
      config: byHand,
      requestedModel: "group/g",
      state,
      context: { ...context, reasoning: true, effort: "low" },
      classify: async () => undefined,
    });
    expect(classifyTurn).toHaveBeenCalledTimes(1);
    expect(classifyTurn.mock.calls[0]?.[0]).toMatchObject({ intents: [], effort: true });
    expect(planned.candidates.map((candidate) => candidate.model.id)).toEqual(["b"]);
    expect(planned.candidates[0]?.ruleEffort).toBe("high");
  });
});

describe("explicit provider routes", () => {
  const twoProviders: GatewayConfig = {
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "one",
        protocol: "openai",
        baseUrl: "https://one.test/v1",
        models: [{ id: "shared" }],
      },
      {
        id: "two",
        protocol: "openai",
        baseUrl: "https://two.test/v1",
        models: [{ id: "shared" }],
      },
    ],
    groups: [],
  };

  it("sends provider/model to that provider, not to the found group for the model", async () => {
    const planned = await planRequestCandidates({
      config: twoProviders,
      requestedModel: "two/shared",
      state,
      context,
    });
    expect(
      planned.candidates.map((candidate) => `${candidate.provider.id}/${candidate.model.id}`),
    ).toEqual(["two/shared"]);
    expect(planned.rule).toBeNull();
  });
});
