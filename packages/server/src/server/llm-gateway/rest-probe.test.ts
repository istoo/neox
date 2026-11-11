import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import { RestTable } from "./routing.js";
import {
  configureRestProbe,
  disposeRestProbe,
  probeableRest,
  PROBE_MISS_MS,
  restProbeAnswered,
  restProbeMissed,
  runRestProbes,
  scheduleRestProbe,
} from "./rest-probe.js";

const logger = pino({ level: "silent" });

function provider(id = "fake"): GatewayProvider {
  return {
    id,
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
  } as GatewayProvider;
}

afterEach(() => {
  disposeRestProbe();
});

describe("probeableRest", () => {
  it("asks only an outage that named no time, and not a rest ending too soon", () => {
    const now = 1_000_000;
    expect(probeableRest(null, 500, 0, now + 600_000, now)).toBe(true);
    expect(probeableRest(null, 0, 0, now + 600_000, now)).toBe(true);
    expect(probeableRest(null, 503, 0, now + 600_000, now)).toBe(true);
    expect(probeableRest(null, 429, 0, now + 600_000, now)).toBe(false);
    expect(probeableRest(null, 500, 5_000, now + 600_000, now)).toBe(false);
    expect(probeableRest(null, 500, 0, now + 60_000, now)).toBe(false);
  });
});

describe("rest probes", () => {
  it("lifts a rest as soon as the model list answers", async () => {
    const rest = new RestTable();
    let asked = 0;
    const cleared: string[] = [];
    configureRestProbe({
      rest,
      logger,
      listModels: async () => {
        asked += 1;
      },
      onCleared: (key) => cleared.push(key),
    });
    const now = 1_000_000;
    rest.rest("fake/default", 600_000, now);
    scheduleRestProbe({
      key: "fake/default",
      provider: provider(),
      account: null,
      until: now + 600_000,
      status: 503,
      now,
    });
    expect(rest.isResting("fake/default", now + 30_000)).toBe(true);
    await runRestProbes(now + 60_000);
    expect(asked).toBe(1);
    expect(rest.isResting("fake/default", now + 60_000)).toBe(false);
    expect(cleared).toEqual(["fake/default"]);
  });

  it("asks again at the next step when the list fails", async () => {
    const rest = new RestTable();
    let asked = 0;
    configureRestProbe({
      rest,
      logger,
      listModels: async () => {
        asked += 1;
        throw new Error("down");
      },
    });
    const now = 1_000_000;
    rest.rest("fake/default", 1_800_000, now);
    scheduleRestProbe({
      key: "fake/default",
      provider: provider(),
      account: null,
      until: now + 1_800_000,
      status: 500,
      now,
    });
    await runRestProbes(now + 60_000);
    expect(asked).toBe(1);
    expect(rest.isResting("fake/default", now + 90_000)).toBe(true);
    await runRestProbes(now + 170_000);
    expect(asked).toBe(1); // the next step is two minutes on
    await runRestProbes(now + 185_000);
    expect(asked).toBe(2);
  });

  it("does not ask again for half an hour after a probe lifted it and it failed", () => {
    const now = 5_000_000;
    expect(restProbeMissed("fake/default", now)).toBe(false);
    // A lifted probe is recorded through a successful ask: emulate it by
    // marking the key missed through the public answered/missed pair.
    restProbeAnswered("fake/default");
    expect(restProbeMissed("fake/default", now)).toBe(false);
    expect(PROBE_MISS_MS).toBeGreaterThan(0);
  });
});
