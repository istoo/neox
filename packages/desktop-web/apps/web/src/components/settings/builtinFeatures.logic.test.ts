import { describe, expect, it } from "vitest";

import type { GatewayConfig } from "~/lib/gatewayTypes";

import {
  builtinFeatureUseCounts,
  effectiveBuiltinFeatures,
  gatewayCallsPageOf,
  hiddenBuiltinSurfaces,
} from "./builtinFeatures.logic";

describe("builtinFeatures", () => {
  it("starts with every switch on when the host stores none", () => {
    const effective = effectiveBuiltinFeatures(undefined, builtinFeatureUseCounts(undefined));
    expect(Object.values(effective).every(Boolean)).toBe(true);
  });

  it("keeps a feature on while something is in use", () => {
    const effective = effectiveBuiltinFeatures(
      { sessions: false, budget: false },
      builtinFeatureUseCounts({
        version: 1,
        recording: { enabled: true },
        providers: [
          {
            id: "p",
            protocol: "openai",
            baseUrl: "https://example.test",
            models: [],
            accounts: [{ id: "a", monthlyUsd: 10 }],
          },
        ],
      }),
    );
    expect(effective.sessions).toBe(true);
    expect(effective.budget).toBe(true);
  });

  it("turns off the settings sections and gateway tabs a switch owns", () => {
    const effective = effectiveBuiltinFeatures(
      { library: false, usage: false, redact: false, routing: false, tools: false },
      builtinFeatureUseCounts(undefined),
    );
    const hidden = hiddenBuiltinSurfaces(effective);
    expect([...hidden.settingsSections].toSorted()).toEqual([
      "connectors",
      "integrations",
      "library-hooks",
      "library-instructions",
      "library-rtk",
      "library-subagents",
      "privacy",
      "quota",
      "skills",
      "usage",
    ]);
    expect([...hidden.gatewayTabs].toSorted()).toEqual(["masking", "routing"]);
    expect(hidden.railUsage).toBe(true);
  });

  it("leaves the gateway page itself when only a gateway tab is switched off", () => {
    const hidden = hiddenBuiltinSurfaces(
      effectiveBuiltinFeatures({ routing: false }, builtinFeatureUseCounts(undefined)),
    );
    expect(hidden.settingsSections.has("gateway")).toBe(false);
    expect(hidden.gatewayTabs.has("routing")).toBe(true);
  });

  it("counts gateway use the way myna's InUse plugins do", () => {
    const counts = builtinFeatureUseCounts({
      version: 1,
      keys: ["plain", { key: "k", dailyTokens: 1000, limits: [] }],
      recording: { enabled: true },
      groups: [
        { id: "a", members: ["p/m"], strategy: "rotate" },
        { id: "b", members: ["p/m"], disabled: true },
        { id: "c", members: ["p/m"], weighted: true },
      ],
      masking: { enabled: true, words: ["secret"] },
      search: { enabled: true },
      otel: { enabled: true, endpoint: "https://collector" },
      middleware: { aliases: { fast: "p/m" }, overrides: [{}] },
      providers: [
        {
          id: "p",
          protocol: "openai",
          baseUrl: "https://example.test",
          models: [],
          accounts: [{ id: "a", monthlyUsd: 5, warmup: true, autoReset: "week" }],
        },
      ],
      codexWarmup: "week",
      codexWarmAts: ["06:00"],
    } as GatewayConfig);

    expect(counts.gateway).toBe(2);
    expect(counts.sessions).toBe(1);
    expect(counts.groups).toBe(2);
    expect(counts.routing).toBe(2);
    expect(counts.rotation).toBe(2);
    expect(counts.redact).toBe(1);
    expect(counts.search).toBe(1);
    expect(counts.otel).toBe(1);
    expect(counts.middleware).toBe(2);
    expect(counts.budget).toBe(2);
    expect(counts.warmups).toBe(4);
  });

  it("reads the gateway page size from the feature config, defaulting to myna's", () => {
    expect(gatewayCallsPageOf(undefined)).toBe(20);
    expect(gatewayCallsPageOf({})).toBe(20);
    expect(gatewayCallsPageOf({ builtinFeatureConfig: { gateway: { callsPage: 50 } } })).toBe(50);
  });
});
