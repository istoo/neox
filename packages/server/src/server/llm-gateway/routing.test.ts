import { describe, expect, it } from "vitest";
import type { GatewayCandidate } from "./catalog.js";
import { parseMemberRef } from "./catalog.js";
import type { GatewayConfig } from "./config.js";
import { planRequestCandidates, weightedOrder } from "./group-rules.js";
import { RouteTrace, summarizePrompt } from "./route-trace.js";
import {
  candidateKey,
  noteAffinity,
  planCandidates,
  planPluginStrategy,
  RestTable,
  routingFor,
  strategyFor,
  type AffinityRecord,
  type RoutingState,
} from "./routing.js";
import { setGatewayRoutingStrategyRunner } from "./plugin-upstream.js";

function candidate(providerId: string, modelId = "m"): GatewayCandidate {
  return {
    provider: {
      id: providerId,
      protocol: "anthropic",
      baseUrl: "https://example.test/v1",
      models: [{ id: modelId }],
    },
    model: { id: modelId },
  };
}

function configWithGroup(
  strategy: GatewayConfig["groups"][number]["strategy"],
  extra: Partial<GatewayConfig["groups"][number]> = {},
): GatewayConfig {
  return {
    version: 1,
    enabled: true,
    keys: [],
    providers: [],
    pricing: {},
    groups: [{ id: "g", members: ["a/m", "b/m", "c/m"], strategy, ...extra }],
  };
}

function state(usage: Record<string, number> = {}): RoutingState {
  return {
    rest: new RestTable(),
    rotationCursors: new Map(),
    usageCounts: new Map(Object.entries(usage)),
    sticky: new Map(),
    lastUsed: new Map(),
    speedProbes: new Map(),
    drainAt: new Map(),
    spent: new Set(),
  };
}

const candidates = [candidate("a"), candidate("b"), candidate("c")];

describe("RestTable", () => {
  it("skips a rested upstream until its window ends", () => {
    const rest = new RestTable();
    rest.rest("a/m", 1000, 5000);
    expect(rest.isResting("a/m", 5500)).toBe(true);
    expect(rest.isResting("a/m", 6001)).toBe(false);
  });

  it("keeps the later of two overlapping windows", () => {
    const rest = new RestTable();
    rest.rest("a/m", 60_000, 0);
    rest.rest("a/m", 1000, 30_000);
    expect(rest.isResting("a/m", 59_000)).toBe(true);
  });
});

describe("planCandidates", () => {
  it("keeps member order for an ungrouped model", () => {
    const planned = planCandidates({
      config: configWithGroup("order"),
      requestedModel: "a/m",
      candidates,
      state: state(),
      now: 0,
      conversationKey: null,
    });
    expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("rotates the starting member on each request", () => {
    const routing = state();
    const first = planCandidates({
      config: configWithGroup("rotate"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 0,
      conversationKey: null,
    });
    const second = planCandidates({
      config: configWithGroup("rotate"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 1,
      conversationKey: null,
    });
    expect(first.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
    expect(second.map(candidateKey)).toEqual(["b/m", "c/m", "a/m"]);
  });

  it("puts the least-used member first", () => {
    const planned = planCandidates({
      config: configWithGroup("least-used"),
      requestedModel: "group/g",
      candidates,
      state: state({ "a/m": 5, "b/m": 1, "c/m": 3 }),
      now: 0,
      conversationKey: null,
    });
    expect(planned.map(candidateKey)).toEqual(["b/m", "c/m", "a/m"]);
  });

  it("moves a resting member behind the awake ones", () => {
    const routing = state();
    routing.rest.rest("a/m", 60_000, 0);
    const planned = planCandidates({
      config: configWithGroup("order"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 1000,
      conversationKey: null,
    });
    expect(planned.map(candidateKey)).toEqual(["b/m", "c/m", "a/m"]);
  });

  it("prefers the upstream that has rested longest for smart routing", () => {
    const routing = state();
    routing.lastUsed.set("a/m", 5000);
    routing.lastUsed.set("b/m", 1000);
    const planned = planCandidates({
      config: configWithGroup("smart"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 6000,
      conversationKey: null,
    });
    expect(planned.map(candidateKey)).toEqual(["c/m", "b/m", "a/m"]);
  });

  it("breaks pace ties by served request count", () => {
    const routing = state({ "a/m": 4, "b/m": 1 });
    const planned = planCandidates({
      config: configWithGroup("pace"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 0,
      conversationKey: null,
    });
    expect(planned.map(candidateKey)).toEqual(["c/m", "b/m", "a/m"]);
  });

  it("keeps a conversation on the upstream that answered it", () => {
    const routing = state();
    routing.sticky.set("conv-1", "c/m");
    const planned = planCandidates({
      config: configWithGroup("order"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 0,
      conversationKey: "conv-1",
    });
    expect(planned.map(candidateKey)).toEqual(["c/m", "a/m", "b/m"]);
  });

  it("does not bind one conversation's upstream to another", () => {
    const routing = state();
    routing.sticky.set("conv-1", "c/m");
    const planned = planCandidates({
      config: configWithGroup("order"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 0,
      conversationKey: "conv-2",
    });
    expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("ignores a sticky upstream that is no longer a member", () => {
    const routing = state();
    routing.sticky.set("conv-1", "z/m");
    const planned = planCandidates({
      config: configWithGroup("order"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 0,
      conversationKey: "conv-1",
    });
    expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("falls back to the full list when every member is resting", () => {
    const routing = state();
    for (const entry of candidates) {
      routing.rest.rest(candidateKey(entry), 60_000, 0);
    }
    const planned = planCandidates({
      config: configWithGroup("order"),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 1000,
      conversationKey: null,
    });
    expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });
});

describe("RouteTrace", () => {
  it("counts a request once and forgets none of its tries when it finishes", () => {
    const trace = new RouteTrace();
    const route = trace.start({
      time: 1000,
      agent: "Claude Code",
      key: null,
      model: "claude-sonnet-5",
      routedModel: "claude-sonnet-5",
      alias: null,
      group: null,
      strategy: "order",
      provider: "a",
      providerLabel: "A",
      seats: [],
      tries: [],
      prompt: null,
      masked: false,
    });
    trace.update(route.id, (entry) => {
      entry.tries.push({
        provider: "a",
        account: "one",
        model: "m",
        start: 1000,
        done: true,
        status: 429,
        millis: 20,
        error: "HTTP 429",
      });
      entry.tries.push({
        provider: "b",
        account: "two",
        model: "m",
        start: 1020,
        done: true,
        status: 200,
        millis: 30,
        error: null,
      });
    });
    trace.finish(route.id, { status: 200, error: null, now: 1100 });
    const snapshot = trace.snapshot();
    expect(snapshot.stats).toEqual({ requests: 1, rerouted: 1, errors: 0, active: 0 });
    expect(snapshot.routes[0]?.tries).toHaveLength(2);
    expect(snapshot.routes[0]?.millis).toBe(100);
  });

  it("counts a request whose upstreams all failed as an agent error", () => {
    const trace = new RouteTrace();
    const route = trace.start({
      time: 1000,
      agent: "Codex",
      key: null,
      model: "m",
      routedModel: "m",
      alias: null,
      group: null,
      strategy: "order",
      provider: "a",
      providerLabel: "A",
      seats: [],
      tries: [],
      prompt: null,
      masked: false,
    });
    trace.finish(route.id, { status: 502, error: "HTTP 502", now: 1200 });
    expect(trace.snapshot().stats.errors).toBe(1);
  });
});

describe("summarizePrompt", () => {
  it("splits an Anthropic body into system, tools and conversation", () => {
    const prompt = summarizePrompt(
      {
        model: "m",
        system: "You are a coding agent.",
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "hello there" },
          { role: "assistant", content: "hi" },
        ],
      },
      200_000,
    );
    expect(prompt?.window).toBe(200_000);
    expect(prompt?.parts.map((part) => part.kind)).toEqual(["system", "tools", "messages"]);
    expect(prompt?.parts[1]?.items[0]?.name).toBe("read_file");
    expect(prompt?.tokens).toBeGreaterThan(0);
    expect(prompt?.slices?.map((slice) => slice.kind)).toEqual(["system", "tools", "chat"]);
  });

  it("reads a tool result the protocol sends as its own role as results", () => {
    const prompt = summarizePrompt(
      {
        model: "m",
        messages: [
          { role: "user", content: "run it" },
          { role: "tool", content: "a.txt" },
        ],
      },
      null,
    );

    expect(prompt?.slices).toEqual([
      { kind: "results", tokens: expect.any(Number) },
      { kind: "chat", tokens: expect.any(Number) },
    ]);
  });
});

function groupConfig(overrides: Partial<GatewayConfig["groups"][number]> = {}): GatewayConfig {
  const provider = (id: string): GatewayConfig["providers"][number] => ({
    id,
    protocol: "anthropic",
    baseUrl: "https://example.test/v1",
    models: [{ id: "m" }],
  });
  return {
    version: 1,
    enabled: true,
    keys: [],
    providers: [provider("a"), provider("b")],
    groups: [{ id: "g", members: ["a/m", "b/m"], strategy: "order", ...overrides }],
  };
}

describe("parseMemberRef", () => {
  it("splits a pinned effort off a member", () => {
    expect(parseMemberRef("a/m:high")).toEqual({ member: "a/m:high", id: "a/m", effort: "high" });
    expect(parseMemberRef("a/m")).toEqual({ member: "a/m", id: "a/m", effort: null });
  });

  it("keeps a colon that is not a known level in the model id", () => {
    expect(parseMemberRef("a/m:free")).toEqual({
      member: "a/m:free",
      id: "a/m:free",
      effort: null,
    });
  });
});

describe("weightedOrder", () => {
  it("turns members smoothly by their weights", () => {
    const group = groupConfig({ weighted: true, weights: { "a/m": 3 } }).groups[0]!;
    const routing = state();
    const picks: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      picks.push(weightedOrder(group, group.members, routing)[0]!);
    }
    expect(picks).toEqual(["a/m", "a/m", "b/m", "a/m"]);
  });
});

describe("planRequestCandidates", async () => {
  const baseContext = {
    agent: "Claude Code",
    tokens: 10,
    images: false,
    effort: null,
    reasoning: false,
    folder: null,
    compact: false,
    text: "",
    now: Date.parse("2026-01-05T10:00:00Z"),
  };

  it("puts a matching rule's member first and keeps its order", async () => {
    const config = groupConfig({ rules: [{ use: "b/m", tokens: 100 }] });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, tokens: 200 },
    });
    expect(plan.candidates.map((entry) => entry.provider.id)).toEqual(["b", "a"]);
    expect(plan.preserveOrder).toBe(true);
  });

  it("leaves the order alone when the rule does not hold", async () => {
    const config = groupConfig({ rules: [{ use: "b/m", tokens: 100 }] });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, tokens: 20 },
    });
    expect(plan.candidates.map((entry) => entry.provider.id)).toEqual(["a", "b"]);
    expect(plan.preserveOrder).toBe(false);
  });

  it("leaves a paused member out of the group", async () => {
    const config = groupConfig({
      rules: [{ use: "a/m", pause: true, agents: ["claude code"] }],
    });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates.map((entry) => entry.provider.id)).toEqual(["b"]);
    expect(plan.paused).toEqual(["a/m"]);
  });

  it("does not judge an intent rule when no classifier transport is given", async () => {
    const config = groupConfig({ rules: [{ use: "b/m", intent: "writing tests" }] });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates.map((entry) => entry.provider.id)).toEqual(["a", "b"]);
  });

  it("reads a member's pinned effort and the group's fast list", async () => {
    const config = groupConfig({
      members: ["a/m:high", "b/m"],
      fast: ["b/m"],
    });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates[0]?.effort).toBe("high");
    expect(plan.candidates[1]?.fast).toBe(true);
  });

  it("holds a time window in its own zone", async () => {
    const config = groupConfig({
      rules: [{ use: "b/m", time: { from: "09:00", to: "11:00", zone: "UTC", days: ["mon"] } }],
    });
    const inWindow = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, now: Date.parse("2026-01-05T10:00:00Z") },
    });
    const outside = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, now: Date.parse("2026-01-05T12:00:00Z") },
    });
    expect(inWindow.candidates[0]?.provider.id).toBe("b");
    expect(outside.candidates[0]?.provider.id).toBe("a");
  });
});

describe("routing group members", () => {
  const baseContext = {
    agent: "claude-code",
    tokens: 10,
    images: false,
    effort: null,
    reasoning: false,
    folder: null,
    compact: false,
    text: "",
    now: Date.parse("2026-01-05T10:00:00Z"),
  };

  it("adds the models its match patterns find, after its members", async () => {
    const config: GatewayConfig = {
      version: 1,
      enabled: true,
      keys: [],
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: "https://a.test/v1",
          models: [{ id: "m" }, { id: "m2" }, { id: "other" }],
        },
      ],
      groups: [{ id: "g", members: ["a/m"], strategy: "order", match: ["a/m*"] }],
    };
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates.map((entry) => entry.model.id)).toEqual(["m", "m2"]);
  });

  it("leaves switched-off members out of every request", async () => {
    const config = groupConfig({ off: ["a/m"] });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates.map((entry) => entry.provider.id)).toEqual(["b"]);
  });

  it("turns a request away from a switched-off group", async () => {
    const config = groupConfig({ disabled: true });
    await expect(
      planRequestCandidates({
        config,
        requestedModel: "group/g",
        state: state(),
        context: baseContext,
      }),
    ).rejects.toThrow("switched off");
  });

  it("sends a picked member first when no rule matches", async () => {
    const config = groupConfig({ pick: "b/m" });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates.map((entry) => entry.provider.id)).toEqual(["b", "a"]);
  });

  it("fits a pinned effort to the levels the group offers", async () => {
    const config = groupConfig({ members: ["a/m:max"], levels: ["low", "high"] });
    const plan = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(plan.candidates[0]?.effort).toBe("high");
  });

  it("matches a rule by the folder the request says", async () => {
    const config = groupConfig({ rules: [{ use: "b/m", folders: ["/work/proj"] }] });
    const inside = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, folder: "/work/proj/sub" },
    });
    const outside = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, folder: "/work/other" },
    });
    expect(inside.candidates[0]?.provider.id).toBe("b");
    expect(outside.candidates[0]?.provider.id).toBe("a");
  });

  it("matches a rule that asks for a compaction", async () => {
    const config = groupConfig({ rules: [{ use: "b/m", compact: true }] });
    const compaction = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: { ...baseContext, compact: true },
    });
    const turn = await planRequestCandidates({
      config,
      requestedModel: "group/g",
      state: state(),
      context: baseContext,
    });
    expect(compaction.candidates[0]?.provider.id).toBe("b");
    expect(turn.candidates[0]?.provider.id).toBe("a");
  });

  it("picks the first member by weight and keeps the others in group order", () => {
    const group = groupConfig({
      weighted: true,
      members: ["a/m", "b/m", "c/m"],
      weights: { "a/m": 3 },
    }).groups[0]!;
    const routing = state();
    const orders: string[][] = [];
    for (let index = 0; index < 4; index += 1) {
      orders.push(weightedOrder(group, group.members, routing));
    }
    expect(orders.map((order) => order[0])).toEqual(["a/m", "b/m", "a/m", "c/m"]);
    // The rest follow the weighted pick in the order the group lists them.
    expect(orders[0]).toEqual(["a/m", "b/m", "c/m"]);
    expect(orders[1]).toEqual(["b/m", "a/m", "c/m"]);
    expect(orders[3]).toEqual(["c/m", "a/m", "b/m"]);
  });
});

describe("free", () => {
  it("puts a member whose model costs nothing first", () => {
    const config: GatewayConfig = {
      ...configWithGroup("free"),
      pricing: {
        "a/m": { inputPerMTok: 1, outputPerMTok: 1 },
        "b/m": { inputPerMTok: 0, outputPerMTok: 0 },
      },
    };
    const planned = planCandidates({
      config,
      requestedModel: "group/g",
      candidates,
      state: state(),
      now: 0,
      conversationKey: null,
    });
    expect(planned.map((entry) => entry.provider.id)).toEqual(["b", "a", "c"]);
  });

  it("counts every model of a provider the user marked free", () => {
    const [first, second] = [candidate("a"), candidate("b")];
    first.provider.countFree = true;
    const planned = planCandidates({
      config: configWithGroup("free"),
      requestedModel: "group/g",
      candidates: [second, first],
      state: state(),
      now: 0,
      conversationKey: null,
    });
    expect(planned.map((entry) => entry.provider.id)).toEqual(["a", "b"]);
  });
});

describe("cheap", () => {
  it("sends the request where the model costs least now", () => {
    const config: GatewayConfig = {
      ...configWithGroup("cheap"),
      pricing: {
        "a/m": { inputPerMTok: 1, outputPerMTok: 1 },
        "b/m": { inputPerMTok: 2, outputPerMTok: 2 },
      },
    };
    const planned = planCandidates({
      config,
      requestedModel: "group/g",
      candidates: [candidate("b"), candidate("a")],
      state: state(),
      now: 0,
      conversationKey: null,
    });
    expect(planned.map((entry) => entry.provider.id)).toEqual(["a", "b"]);
  });

  it("reads a rate window at the request's time", () => {
    const priced = candidate("a");
    priced.provider.priceRate = 1;
    priced.provider.rateWindows = [{ start: "09:00", end: "18:00", rate: 3 }];
    const config: GatewayConfig = {
      ...configWithGroup("cheap"),
      pricing: {
        "a/m": { inputPerMTok: 1, outputPerMTok: 1 },
        "b/m": { inputPerMTok: 2, outputPerMTok: 2 },
      },
    };
    const planned = planCandidates({
      config,
      requestedModel: "group/g",
      candidates: [priced, candidate("b")],
      state: state(),
      now: new Date(2026, 0, 5, 10, 0).getTime(),
      conversationKey: null,
    });
    expect(planned.map((entry) => entry.provider.id)).toEqual(["b", "a"]);
  });

  it("puts a price it does not know behind those it does", () => {
    const config: GatewayConfig = {
      ...configWithGroup("cheap"),
      pricing: { "b/m": { inputPerMTok: 2, outputPerMTok: 2 } },
    };
    const planned = planCandidates({
      config,
      requestedModel: "group/g",
      candidates: [candidate("a"), candidate("b")],
      state: state(),
      now: 0,
      conversationKey: null,
    });
    expect(planned.map((entry) => entry.provider.id)).toEqual(["b", "a"]);
  });
});

describe("fast", () => {
  it("puts the one that answered fastest lately first", () => {
    const routing = state();
    routing.speed = new Map([
      ["a/m", { ttft: 300, tps: 50 }],
      ["b/m", { ttft: 100, tps: 50 }],
    ]);
    const planned = planCandidates({
      config: configWithGroup("fast"),
      requestedModel: "group/g",
      candidates: candidates.slice(0, 2),
      state: routing,
      now: 0,
      conversationKey: null,
    });
    expect(planned.map((entry) => entry.provider.id)).toEqual(["b", "a"]);
  });

  it("gives a member not measured lately a turn now and then", () => {
    const routing = state();
    routing.speed = new Map([["a/m", { ttft: 100, tps: 50 }]]);
    const input = {
      config: configWithGroup("fast"),
      requestedModel: "group/g",
      candidates: candidates.slice(0, 2),
      state: routing,
      now: 0,
      conversationKey: null,
    };
    for (let turn = 0; turn < 4; turn += 1) {
      expect(planCandidates(input)[0]?.provider.id).toBe("a");
    }
    expect(planCandidates(input)[0]?.provider.id).toBe("b");
  });
});

describe("drain", () => {
  it("stays on the first member until it is spent, then moves on and never back", () => {
    const routing = state();
    const input = {
      config: configWithGroup("drain"),
      requestedModel: "group/g",
      candidates: candidates.slice(0, 2),
      state: routing,
      now: 0,
      conversationKey: null,
    };
    expect(planCandidates(input).map((entry) => entry.provider.id)).toEqual(["a", "b"]);
    routing.spent?.add("a/m");
    expect(planCandidates(input).map((entry) => entry.provider.id)).toEqual(["b", "a"]);
    routing.spent?.delete("a/m");
    expect(planCandidates(input).map((entry) => entry.provider.id)).toEqual(["b", "a"]);
  });
});

describe("provider routing", () => {
  function withRouting(routing?: "smart" | "order" | "usage" | "weight"): GatewayConfig {
    return {
      version: 1,
      enabled: true,
      keys: [],
      providers: [
        {
          id: "p",
          protocol: "openai",
          baseUrl: "https://p.test/v1",
          ...(routing === undefined ? {} : { routing }),
          models: [{ id: "m" }],
        },
      ],
      groups: [{ id: "g", members: ["p/m"], strategy: "rotate" }],
      pricing: {},
    } as GatewayConfig;
  }

  it("defaults a provider with no routing to smart", () => {
    // Existing configs change here: a provider without `routing` used to be
    // tried in order, and is smart now (myna provider.go:123-135).
    expect(strategyFor(withRouting(), "p/m")).toBe("smart");
    expect(routingFor(withRouting(), "p/m")).toEqual({ strategy: "smart", weighted: false });
  });

  it("maps a provider's routing to the strategy that serves it", () => {
    expect(strategyFor(withRouting("order"), "p/m")).toBe("order");
    expect(routingFor(withRouting("usage"), "p/m")).toEqual({
      strategy: "least-used",
      weighted: false,
    });
    expect(routingFor(withRouting("weight"), "p/m")).toEqual({
      strategy: "order",
      weighted: true,
    });
  });

  it("keeps a group's own strategy, and keeps order for a provider it cannot find", () => {
    expect(strategyFor(withRouting(), "group/g")).toBe("rotate");
    expect(strategyFor(withRouting(), "unknown/m")).toBe("order");
  });
});

describe("stays (affinity)", () => {
  function bound(): RoutingState {
    const routing = state();
    routing.sticky.set("conversation", "b/m");
    return routing;
  }

  it("keeps the member that answered for auto and session", () => {
    for (const affinity of ["auto", "session"] as const) {
      const planned = planCandidates({
        config: configWithGroup("order", { affinity }),
        requestedModel: "group/g",
        candidates,
        state: bound(),
        now: 0,
        conversationKey: "conversation",
      });
      expect(planned.map(candidateKey)).toEqual(["b/m", "a/m", "c/m"]);
    }
  });

  it("routes afresh for off and turn", () => {
    for (const affinity of ["off", "turn"] as const) {
      const planned = planCandidates({
        config: configWithGroup("order", { affinity }),
        requestedModel: "group/g",
        candidates,
        state: bound(),
        now: 0,
        conversationKey: "conversation",
      });
      expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
    }
  });

  function answered(routing: RoutingState, record: Partial<AffinityRecord> = {}): RoutingState {
    routing.affinity = new Map([
      [
        "conversation",
        {
          key: "b/m",
          turn: 1,
          within: false,
          at: 0,
          cacheRead: 2048,
          cacheWrite: 0,
          hourTokens: 0,
          hourAt: 0,
          ...record,
        },
      ],
    ]);
    return routing;
  }

  function plan(routing: RoutingState, now: number, extra: { withinTurn?: boolean } = {}) {
    return planCandidates({
      config: configWithGroup("order", { affinity: "auto" }),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now,
      conversationKey: "conversation",
      ...extra,
    });
  }

  it("auto keeps within the turn whatever the cache said", () => {
    const routing = answered(bound(), { cacheRead: 0, cacheWrite: 0 });
    expect(plan(routing, 60 * 60_000, { withinTurn: true }).map(candidateKey)).toEqual([
      "b/m",
      "a/m",
      "c/m",
    ]);
  });

  it("auto keeps across turns while the cache is worth keeping", () => {
    const routing = answered(bound());
    expect(plan(routing, 4 * 60_000).map(candidateKey)).toEqual(["b/m", "a/m", "c/m"]);
  });

  it("auto counts what a first turn wrote as worth keeping", () => {
    const routing = bound();
    noteAffinity(routing, "conversation", {
      key: "b/m",
      turn: 1,
      within: false,
      at: 0,
      usage: { input: 4096, cacheRead: 0, cacheWrite: 0 },
    });
    expect(plan(routing, 4 * 60_000).map(candidateKey)).toEqual(["b/m", "a/m", "c/m"]);
  });

  it("auto routes afresh when the cache was too small to keep", () => {
    const routing = answered(bound(), { cacheRead: 300, cacheWrite: 200 });
    expect(plan(routing, 60_000).map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("auto routes afresh once the vendor's cache has gone cold", () => {
    const routing = answered(bound());
    expect(plan(routing, 6 * 60_000).map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("auto keeps a cold conversation where an hour-long write is still warm", () => {
    const routing = answered(bound(), { hourTokens: 4096, hourAt: 0 });
    expect(plan(routing, 30 * 60_000).map(candidateKey)).toEqual(["b/m", "a/m", "c/m"]);
    expect(plan(routing, 2 * 60 * 60_000).map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("auto lets a ChatGPT backend keep the cache for an hour", () => {
    const chatgpt = candidate("codex");
    chatgpt.provider.baseUrl = "https://chatgpt.com/backend-api/codex";
    const other = candidate("other");
    const routing = answered(bound());
    const at = (now: number) =>
      planCandidates({
        config: configWithGroup("order", { affinity: "auto" }),
        requestedModel: "group/g",
        candidates: [other, chatgpt],
        state: routing,
        now,
        conversationKey: "conversation",
      }).map(candidateKey);
    routing.affinity?.set("conversation", {
      ...(routing.affinity.get("conversation") as AffinityRecord),
      key: "codex/m",
    });
    routing.sticky.set("conversation", "codex/m");
    expect(at(30 * 60_000)).toEqual(["codex/m", "other/m"]);
    expect(at(61 * 60_000)).toEqual(["other/m", "codex/m"]);
    expect(at(2 * 60 * 60_000)).toEqual(["other/m", "codex/m"]);
  });

  it("auto lets DeepSeek's own API keep the cache for an hour", () => {
    const deepseek = candidate("ds");
    deepseek.provider.baseUrl = "https://api.deepseek.com/v1";
    const other = candidate("other");
    const routing = answered(bound());
    routing.sticky.set("conversation", "ds/m");
    routing.affinity?.set("conversation", {
      ...(routing.affinity.get("conversation") as AffinityRecord),
      key: "ds/m",
    });
    const at = (now: number) =>
      planCandidates({
        config: configWithGroup("order", { affinity: "auto" }),
        requestedModel: "group/g",
        candidates: [other, deepseek],
        state: routing,
        now,
        conversationKey: "conversation",
      }).map(candidateKey);
    expect(at(30 * 60_000)).toEqual(["ds/m", "other/m"]);
    expect(at(90 * 60_000)).toEqual(["other/m", "ds/m"]);
  });

  it("turn keeps only within a turn", () => {
    const routing = bound();
    const turn = (withinTurn: boolean) =>
      planCandidates({
        config: configWithGroup("order", { affinity: "turn" }),
        requestedModel: "group/g",
        candidates,
        state: routing,
        now: 0,
        conversationKey: "conversation",
        withinTurn,
      }).map(candidateKey);
    expect(turn(true)).toEqual(["b/m", "a/m", "c/m"]);
    expect(turn(false)).toEqual(["a/m", "b/m", "c/m"]);
  });

  it("noteAffinity keeps an hour-long write warm until it is outread", () => {
    const routing = state();
    noteAffinity(routing, "conversation", {
      key: "b/m",
      turn: 1,
      within: false,
      at: 1000,
      usage: { input: 100, cacheRead: 500, cacheWrite: 0, cacheWrite1h: 700 },
    });
    expect(routing.affinity?.get("conversation")?.hourTokens).toBe(1200);
    // read less than was kept: the hour-long part is gone
    noteAffinity(routing, "conversation", {
      key: "b/m",
      turn: 2,
      within: false,
      at: 2000,
      usage: { input: 100, cacheRead: 600, cacheWrite: 0 },
    });
    expect(routing.affinity?.get("conversation")?.hourTokens).toBe(0);
  });

  it("keeps a strict conversation on its member even resting", () => {
    const routing = bound();
    routing.sticky.set("conversation", "b/m");
    routing.rest.rest("b/m", 60_000, 0);
    const planned = planCandidates({
      config: configWithGroup("order", { affinity: "strict" }),
      requestedModel: "group/g",
      candidates,
      state: routing,
      now: 0,
      conversationKey: "conversation",
    });
    expect(planned.map(candidateKey)).toEqual(["b/m"]);
  });
});

describe("planPluginStrategy", () => {
  it("orders by a plugin strategy's permutation, keeping the plan otherwise", async () => {
    const release = setGatewayRoutingStrategyRunner({
      order: async () => ["c/m", "a/m", "b/m"],
    });
    try {
      const planned = await planPluginStrategy(candidates, {
        config: configWithGroup("plug/reverse"),
        requestedModel: "group/g",
        candidates,
        state: state(),
        now: 0,
      });
      expect(planned.map(candidateKey)).toEqual(["c/m", "a/m", "b/m"]);
    } finally {
      release();
    }
  });

  it("keeps the listed order when the answer isn't a permutation", async () => {
    const release = setGatewayRoutingStrategyRunner({ order: async () => [0, 0, 1] });
    try {
      const planned = await planPluginStrategy(candidates, {
        config: configWithGroup("plug/reverse"),
        requestedModel: "group/g",
        candidates,
        state: state(),
        now: 0,
      });
      expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
    } finally {
      release();
    }
  });

  it("leaves a builtin strategy's plan alone", async () => {
    const planned = await planPluginStrategy(candidates, {
      config: configWithGroup("rotate"),
      requestedModel: "group/g",
      candidates,
      state: state(),
      now: 0,
    });
    expect(planned.map(candidateKey)).toEqual(["a/m", "b/m", "c/m"]);
  });
});
