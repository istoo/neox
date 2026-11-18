import { describe, expect, it } from "vitest";
import { candidateLoads, createAccountRoutingState } from "./accounts.js";
import type { GatewayCandidate } from "./catalog.js";
import type { GatewayModel, GatewayProvider } from "./config.js";
import { busyLast, LOAD_FRESH_MS, planCandidates, RestTable, type ModelLoad } from "./routing.js";

function providerOf(id: string): GatewayProvider {
  return {
    id,
    protocol: "openai",
    baseUrl: `https://${id}.example/v1`,
    apiKey: "k",
    accounts: [],
    models: [],
  };
}

function candidateOf(providerId: string, modelId: string): GatewayCandidate {
  const model: GatewayModel = { id: modelId };
  return { provider: providerOf(providerId), model };
}

const first = candidateOf("a", "one");
const second = candidateOf("b", "two");

describe("Busy models last", () => {
  it("keeps the order when the setting is off", () => {
    const loads = new Map([["b/two", { percent: 99, at: 1_000 }]]);
    const now = 2_000;
    expect(
      busyLast(
        [first, second],
        (candidate) => loads.get(`${candidate.provider.id}/${candidate.model.id}`) ?? null,
        0,
        now,
      ),
    ).toEqual([first, second]);
  });

  it("moves a model past the threshold behind the others", () => {
    const loads = new Map<string, ModelLoad>([["a/one", { percent: 95, at: 1_000 }]]);
    const now = 1_000 + LOAD_FRESH_MS;
    expect(
      busyLast(
        [first, second],
        (candidate) => loads.get(`${candidate.provider.id}/${candidate.model.id}`) ?? null,
        80,
        now,
      ),
    ).toEqual([second, first]);
  });

  it("keeps the place of a model whose load is old or equal to the threshold", () => {
    const loads = new Map<string, ModelLoad>([
      ["a/one", { percent: 99, at: 1_000 }],
      ["b/two", { percent: 80, at: 2_000 }],
    ]);
    const now = 1_000 + LOAD_FRESH_MS + 1;
    expect(
      busyLast(
        [first, second],
        (candidate) => loads.get(`${candidate.provider.id}/${candidate.model.id}`) ?? null,
        80,
        now,
      ),
    ).toEqual([first, second]);
  });

  it("keeps the order when nothing reports a load", () => {
    expect(busyLast([first, second], undefined, 80, 1_000)).toEqual([first, second]);
  });

  it("reads a provider's load from the concurrency it has in flight", () => {
    const provider: GatewayProvider = {
      ...providerOf("a"),
      accounts: [
        { id: "one", apiKey: "k", maxConcurrency: 2, models: [] },
        { id: "two", apiKey: "k", maxConcurrency: 2, models: [] },
      ],
    };
    const state = createAccountRoutingState(new RestTable());
    state.inflight.set("a/one", 2);
    state.inflight.set("a/two", 1);
    const loads = candidateLoads({
      candidates: [{ provider, model: { id: "m" } }],
      state,
      now: 1_000,
    });
    expect(loads.get("a/m")).toEqual({ percent: 75, at: 1_000 });
  });

  it("reports no load for a provider whose concurrency it cannot know", () => {
    const state = createAccountRoutingState(new RestTable());
    const loads = candidateLoads({
      candidates: [first],
      state,
      now: 1_000,
    });
    expect(loads.get("a/one")).toBeUndefined();
  });

  it("moves the loaded model behind the others when planning", () => {
    const loads = new Map<string, ModelLoad>([["a/one", { percent: 95, at: 1_000 }]]);
    const planned = planCandidates({
      config: { version: 1, enabled: true, keys: [], providers: [], groups: [], busyLoad: 80 },
      requestedModel: "group/g",
      candidates: [first, second],
      state: {
        rest: new RestTable(),
        rotationCursors: new Map(),
        usageCounts: new Map(),
        sticky: new Map(),
        lastUsed: new Map(),
      },
      now: 1_000,
      conversationKey: null,
      loadOf: (candidate) => loads.get(`${candidate.provider.id}/${candidate.model.id}`) ?? null,
    });
    expect(planned).toEqual([second, first]);
  });
});
