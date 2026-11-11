import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "../llm-gateway/config.js";
import { builtinFeatureUseCounts, isBuiltinFeatureActive } from "./builtin-feature-gates.js";

function gateway(overrides: Record<string, unknown> = {}): GatewayConfig {
  return {
    codexWarmup: "off",
    claudeWarmup: "off",
    codexWarmAts: [],
    claudeWarmAts: [],
    keys: [],
    providers: [],
    groups: [],
    ...overrides,
  } as unknown as GatewayConfig;
}

describe("builtinFeatureUseCounts", () => {
  it("counts nothing on an empty gateway", () => {
    const counts = builtinFeatureUseCounts(gateway());

    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  it("counts the configs myna counts", () => {
    const counts = builtinFeatureUseCounts(
      gateway({
        keys: [{ key: "one" }, { key: "two", monthlyUsd: 10 }],
        providers: [
          {
            id: "claude",
            accounts: [{ id: "main", monthlyUsd: 20, warmup: true }],
          },
        ],
        groups: [
          { id: "fast", members: ["claude/x"], strategy: "rotate" },
          { id: "plain", members: ["claude/y"], strategy: "order" },
        ],
        recording: { enabled: true },
        masking: { enabled: true },
        search: { enabled: true },
        otel: { enabled: true, endpoint: "https://collector.example" },
        middleware: { aliases: { a: "b" }, overrides: [], hooks: { request: "x" } },
      }),
    );

    expect(counts).toMatchObject({
      gateway: 2,
      sessions: 1,
      groups: 2,
      routing: 2,
      rotation: 1,
      redact: 1,
      search: 1,
      otel: 1,
      warmups: 1,
      middleware: 2,
      budget: 2,
    });
  });

  it("counts an account's reset timer and its lead as warm-ups", () => {
    const counts = builtinFeatureUseCounts(
      gateway({
        codexResetLead: 15,
        providers: [
          {
            id: "codex",
            accounts: [{ id: "main", autoReset: "expiring" }],
          },
        ],
      }),
    );

    expect(counts.warmups).toBe(2);
  });
});

describe("isBuiltinFeatureActive", () => {
  it("is on unless the switch says off", () => {
    expect(isBuiltinFeatureActive("redact", { features: undefined, gateway: gateway() })).toBe(
      true,
    );
    expect(
      isBuiltinFeatureActive("redact", { features: { redact: false }, gateway: gateway() }),
    ).toBe(false);
  });

  it("stays on while something uses it, as myna's InUse plugins do", () => {
    const used = gateway({ masking: { enabled: true } });

    expect(isBuiltinFeatureActive("redact", { features: { redact: false }, gateway: used })).toBe(
      true,
    );
  });
});
