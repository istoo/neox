import { describe, expect, it } from "vitest";
import type { GatewayCandidate } from "./catalog.js";
import type { GatewayModel, GatewayProvider } from "./config.js";
import { busyLast, LOAD_FRESH_MS, type ModelLoad } from "./routing.js";

function providerOf(id: string): GatewayProvider {
  return {
    id,
    protocol: "openai",
    baseUrl: `https://${id}.example/v1`,
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
});
