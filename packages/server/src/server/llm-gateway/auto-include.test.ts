import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { mergeAutoIncludedModels, takeAutoIncludedModels } from "./auto-include.js";
import { GatewayConfigStore, type GatewayProvider } from "./config.js";

const logger = pino({ level: "silent" });

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    accounts: [],
    models: [],
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    ...overrides,
  } as GatewayProvider;
}

describe("mergeAutoIncludedModels", () => {
  it("takes the models newly listed that a rule matches", () => {
    const merged = mergeAutoIncludedModels(
      provider({ autoInclude: ["gpt-*"], models: [{ id: "gpt-4" }] }),
      ["gpt-4", "gpt-5", "o3"],
    );
    expect(merged.taken).toEqual(["gpt-5"]);
    expect(merged.provider.models.map((model) => model.id)).toEqual(["gpt-5", "gpt-4"]);
    expect(merged.provider.modelMode).toBe("list");
  });

  it("leaves a model it listed before alone, even when a rule matches", () => {
    const merged = mergeAutoIncludedModels(
      provider({ autoInclude: ["*"], models: [{ id: "a" }, { id: "b" }] }),
      ["a", "b"],
    );
    expect(merged.taken).toEqual([]);
    expect(merged.provider.models.map((model) => model.id)).toEqual(["a", "b"]);
  });

  it("takes a new model picked on a provider that serves its picks", () => {
    const merged = mergeAutoIncludedModels(
      provider({ autoInclude: ["claude-*"], modelMode: "picked", models: [] }),
      ["claude-sonnet-5"],
    );
    expect(merged.provider.modelMode).toBe("picked");
    expect(merged.provider.models).toEqual([{ id: "claude-sonnet-5", picked: true }]);
  });

  it("serves its list again when it served none or the best of each family", () => {
    const none = mergeAutoIncludedModels(provider({ autoInclude: ["*"], modelMode: "none" }), [
      "new-a",
    ]);
    expect(none.provider.modelMode).toBe("list");
    const best = mergeAutoIncludedModels(provider({ autoInclude: ["*"], modelMode: "best" }), [
      "new-a",
    ]);
    expect(best.provider.modelMode).toBe("list");
  });

  it("takes nothing without a rule", () => {
    const merged = mergeAutoIncludedModels(provider({}), ["new-a"]);
    expect(merged.taken).toEqual([]);
    expect(merged.provider.models).toEqual([]);
  });
});

describe("takeAutoIncludedModels", () => {
  it("writes the taken models into the saved provider", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-auto-include-"));
    writeFileSync(
      path.join(home, "gateway.json"),
      JSON.stringify({
        providers: [
          {
            id: "p",
            protocol: "openai",
            baseUrl: "https://example.test/v1",
            autoInclude: ["gpt-*"],
          },
        ],
      }),
    );
    const store = new GatewayConfigStore({ neolixHome: home, logger });
    await store.start();
    const taken = await takeAutoIncludedModels(store, "p", ["gpt-5"]);
    expect(taken).toEqual(["gpt-5"]);
    expect(store.get().providers[0]?.models.map((model) => model.id)).toEqual(["gpt-5"]);
    store.dispose();
  });

  it("stamps when the list was fetched even when no model was taken", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-auto-include-"));
    writeFileSync(
      path.join(home, "gateway.json"),
      JSON.stringify({
        providers: [
          {
            id: "p",
            protocol: "openai",
            baseUrl: "https://example.test/v1",
            autoInclude: ["gpt-*"],
            models: [{ id: "gpt-4" }],
          },
        ],
      }),
    );
    const store = new GatewayConfigStore({ neolixHome: home, logger });
    await store.start();
    const now = 1_700_000_000_000;
    expect(await takeAutoIncludedModels(store, "p", ["gpt-4"], now)).toEqual([]);
    expect(store.get().providers[0]?.listFetchedAt).toBe(now);
    expect(store.get().providers[0]?.models.map((model) => model.id)).toEqual(["gpt-4"]);
    store.dispose();
  });

  it("writes nothing for a provider that is gone", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-auto-include-"));
    const store = new GatewayConfigStore({ neolixHome: home, logger });
    await store.start();
    expect(await takeAutoIncludedModels(store, "gone", ["gpt-5"])).toEqual([]);
    store.dispose();
  });
});
