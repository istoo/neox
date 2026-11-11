import { describe, expect, it } from "vitest";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { builtinFeatureUseCounts } from "./builtin-feature-usage";

function gateway(overrides: Record<string, unknown> = {}): GatewayConfigWire {
  return {
    version: 1,
    enabled: true,
    allowIPs: [],
    corsOrigins: [],
    keys: [],
    providers: [],
    groups: [],
    ...overrides,
  } as unknown as GatewayConfigWire;
}

describe("builtinFeatureUseCounts", () => {
  it("counts nothing on an empty gateway", () => {
    const counts = builtinFeatureUseCounts(gateway());

    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  it("counts what myna's plugins count", () => {
    const counts = builtinFeatureUseCounts(
      gateway({
        keys: [{ key: "one" }, { key: "two", dailyTokens: 1000 }],
        providers: [
          {
            id: "claude",
            protocol: "anthropic",
            baseUrl: "https://api.anthropic.com",
            accounts: [{ id: "main", monthlyUsd: 20, warmup: true }],
          },
        ],
        groups: [
          { id: "fast", members: ["claude/x"], strategy: "rotate" },
          { id: "plain", members: ["claude/y"] },
        ],
        recording: { enabled: true },
        masking: { enabled: true },
        search: { enabled: true },
        otel: { enabled: true, endpoint: "https://collector.example" },
        middleware: { aliases: { a: "b" }, overrides: [], hooks: { request: "x" } },
      } as Record<string, unknown>),
    );

    expect(counts.gateway).toBe(2);
    expect(counts.sessions).toBe(1);
    expect(counts.groups).toBe(2);
    expect(counts.routing).toBe(2);
    expect(counts.rotation).toBe(1);
    expect(counts.redact).toBe(1);
    expect(counts.search).toBe(1);
    expect(counts.otel).toBe(1);
    expect(counts.warmups).toBe(1);
    expect(counts.middleware).toBe(2);
    expect(counts.budget).toBe(2);
  });

  it("counts a warm-up time and a key budget", () => {
    const counts = builtinFeatureUseCounts(
      gateway({ codexWarmAts: ["06:00"], claudeWarmup: "week" }),
    );

    expect(counts.warmups).toBe(2);
  });

  it("counts an account's reset timer and its lead as warm-ups", () => {
    const counts = builtinFeatureUseCounts(
      gateway({
        codexResetLead: 15,
        providers: [
          {
            id: "codex",
            protocol: "openai",
            accounts: [{ id: "main", autoReset: "week" }],
          },
        ],
      } as Record<string, unknown>),
    );

    expect(counts.warmups).toBe(2);
  });
});
