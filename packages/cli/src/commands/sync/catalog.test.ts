import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "@neolix/server/gateway-config";
import { runCatalogSyncCommand } from "./catalog.js";

// Each case starts a real GatewayConfigStore (file watch included); the
// default 5s is tight while other workspaces build in parallel.
vi.setConfig({ testTimeout: 20_000 });

const homes: string[] = [];

async function homeWith(config: GatewayConfig): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "neolix-sync-"));
  homes.push(home);
  await writeFile(join(home, "gateway.json"), `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

async function readConfig(home: string): Promise<GatewayConfig> {
  return JSON.parse(await readFile(join(home, "gateway.json"), "utf8")) as GatewayConfig;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const CONFIG = GatewayConfigSchema.parse({
  providers: [
    {
      id: "acme",
      protocol: "anthropic",
      baseUrl: "https://api.acme.test",
      apiKey: "sk-acme-12345678",
      models: [{ id: "alpha", contextWindow: 200_000 }, { id: "gone" }],
    },
    {
      id: "nokey",
      protocol: "openai",
      baseUrl: "https://api.nokey.test",
      models: [{ id: "x" }],
    },
  ],
});

describe("neox sync", () => {
  it("refetches each ready vendor's list, keeping held facts and dropping the gone", async () => {
    const home = await homeWith(CONFIG);
    const asked: string[] = [];
    const result = await runCatalogSyncCommand(
      { home },
      {
        fetchModels: async (provider) => {
          asked.push(provider.id);
          return { models: ["alpha", "beta"] };
        },
        refreshCatalog: async () => ({ ok: true, models: 123 }),
      },
    );
    expect(asked).toEqual(["acme"]);
    expect(result.refreshed).toEqual([{ id: "acme", count: 2 }]);
    expect(result.catalog).toEqual({ ok: true, models: 123 });
    expect(providerModels(await readConfig(home))).toEqual([
      { id: "alpha", contextWindow: 200_000 },
      { id: "beta", picked: false },
    ]);
  });

  it("reports one vendor's failure and goes on to the next", async () => {
    const home = await homeWith(CONFIG);
    const result = await runCatalogSyncCommand(
      { home },
      {
        fetchModels: async (provider) =>
          provider.id === "acme" ? { models: [], error: "404" } : { models: ["y"] },
        refreshCatalog: async () => ({ ok: false, error: "models.dev answered 503" }),
      },
    );
    expect(result.failed).toEqual([{ id: "acme", error: "404" }]);
    expect(result.refreshed).toEqual([]);
    expect(result.catalog.error).toContain("503");
  });

  it("uses the daemon's sync, whose write it leaves to the daemon", async () => {
    const home = await homeWith(CONFIG);
    const result = await runCatalogSyncCommand(
      { home },
      {
        syncAll: async () => ({
          providers: [{ id: "acme", ids: ["alpha", "beta"], taken: ["beta"] }],
          catalog: { ok: true, models: 90 },
        }),
      },
    );
    expect(result.refreshed).toEqual([{ id: "acme", count: 2 }]);
    expect(result.catalog).toEqual({ ok: true, models: 90 });
    expect(providerModels(await readConfig(home))).toEqual([
      { id: "alpha", contextWindow: 200_000 },
      { id: "gone" },
    ]);
  });
});

function providerModels(config: GatewayConfig): GatewayConfig["providers"][number]["models"] {
  return config.providers[0]?.models ?? [];
}
