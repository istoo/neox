import { NEOLIX_GATEWAY_WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeGatewayHandlers } from "./gatewayRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

function run<A>(handler: AnyHandler | undefined, payload: unknown = {}): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    getGatewayConfig: async () => ({
      config: { version: 1, providers: [] },
      status: { enabled: true, monthSpendUsd: 1.5 },
      searchVendors: [{ vendor: "tavily", name: "Tavily" }],
    }),
    setGatewayConfig: async (config: unknown) => {
      calls.push(["setGatewayConfig", config]);
      return { config, status: { enabled: true } };
    },
    getGatewayStatus: async () => ({ enabled: false }),
    getGatewayUsage: async (query: unknown) => {
      calls.push(["getGatewayUsage", query]);
      return { report: { totals: { calls: 2 } } };
    },
    getGatewayQuota: async (query: unknown) => {
      calls.push(["getGatewayQuota", query]);
      return { quota: { accounts: [] } };
    },
    resetGatewayQuota: async (input: unknown) => {
      calls.push(["resetGatewayQuota", input]);
      return { spent: true, code: "reset", windows: 1 };
    },
    warmGatewayAccount: async (input: unknown) => {
      calls.push(["warmGatewayAccount", input]);
      return { status: 200 };
    },
    testGatewayProviderModel: async (target: unknown, model: string) => {
      calls.push(["testGatewayProviderModel", { target, model }]);
      return { ok: true, status: 200, ms: 12 };
    },
    previewGatewayMasking: async (text: string) => {
      calls.push(["previewGatewayMasking", text]);
      return { text: "masked", hits: [] };
    },
    saveGatewayOidcRule: async (rule: unknown) => {
      calls.push(["saveGatewayOidcRule", rule]);
      return { rules: [rule] };
    },
    getGatewayMaskingSummary: async (days: number) => {
      calls.push(["getGatewayMaskingSummary", days]);
      return { days, records: 0 };
    },
    ...overrides,
  };
  return {
    calls,
    handlers: makeGatewayHandlers({ client } as unknown as BridgeModel),
  };
}

describe("makeGatewayHandlers", () => {
  it("serves the protocol's vendor preset catalog", async () => {
    const { handlers } = harness();
    const result = await run<{ presets: Array<{ id: string }> }>(
      handlers[NEOLIX_GATEWAY_WS_METHODS.presets],
    );
    expect(result.presets.length).toBeGreaterThan(20);
    expect(result.presets.some((preset) => preset.id === "anthropic")).toBe(true);
  });

  it("reads config with status and search vendors", async () => {
    const { handlers } = harness();
    const result = await run<{
      config: { version: number };
      status: { enabled: boolean };
      searchVendors: unknown[];
    }>(handlers[NEOLIX_GATEWAY_WS_METHODS.getConfig]);
    expect(result.config.version).toBe(1);
    expect(result.status.enabled).toBe(true);
    expect(result.searchVendors).toHaveLength(1);
  });

  it("writes the config it was given", async () => {
    const { handlers, calls } = harness();
    const config = { version: 1, providers: [{ id: "x" }] };
    const result = await run<{ config: unknown }>(handlers[NEOLIX_GATEWAY_WS_METHODS.setConfig], {
      config,
    });
    expect(calls).toContainEqual(["setGatewayConfig", config]);
    expect(result.config).toEqual(config);
  });

  it("passes usage queries through", async () => {
    const { handlers, calls } = harness();
    const query = { period: "7d", provider: "zai", limit: 100 };
    await run(handlers[NEOLIX_GATEWAY_WS_METHODS.getUsage], query);
    expect(calls).toContainEqual(["getGatewayUsage", query]);
  });

  it("splits a provider probe target from the model", async () => {
    const { handlers, calls } = harness();
    const target = { baseUrl: "https://api.example.test/v1", apiKey: "x" };
    await run(handlers[NEOLIX_GATEWAY_WS_METHODS.providerTestModel], {
      target,
      model: "model-a",
    });
    expect(calls).toContainEqual(["testGatewayProviderModel", { target, model: "model-a" }]);
  });

  it("forwards a masking preview", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_GATEWAY_WS_METHODS.maskingPreview], { text: "sk-abc" });
    expect(calls).toContainEqual(["previewGatewayMasking", "sk-abc"]);
  });

  it("passes quota reset confirmations through", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_GATEWAY_WS_METHODS.resetQuota], {
      account: "codex-1",
      confirm: true,
    });
    expect(calls).toContainEqual(["resetGatewayQuota", { account: "codex-1", confirm: true }]);
  });

  it("passes a daemon failure through untranslated and logs the method name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = harness({
      getGatewayTrace: async () => {
        throw new Error("update the host");
      },
    });
    await expect(run(handlers[NEOLIX_GATEWAY_WS_METHODS.getTrace])).rejects.toMatchObject({
      message: "update the host",
      code: "neolix.error.unmapped",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${NEOLIX_GATEWAY_WS_METHODS.getTrace} failed: update the host`),
    );
    warn.mockRestore();
  });
});
