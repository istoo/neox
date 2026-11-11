import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  antigravityPoolFile,
  clearAntigravityPoolFromConfig,
  effectiveProviderModels,
  loadAntigravityPool,
  mergeAntigravityLists,
  mergeAntigravityPoolIntoProvider,
  refreshAntigravityPool,
  resetAntigravityPool,
  setAntigravityPool,
} from "./antigravity-pool.js";
import type { GatewayConfig, GatewayConfigStore, GatewayProvider } from "./config.js";
import {
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  type GoogleSubscriptionAccount,
} from "./subscription-store.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neolix-antigravity-pool-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function account(user: string, token = "token"): GoogleSubscriptionAccount {
  return {
    agent: "antigravity",
    id: `antigravity:${user}`,
    user,
    plan: "Standard",
    addedAt: 1,
    lapsed: null,
    accessToken: token,
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    project: "proj-1",
  };
}

function answerWith(models: Record<string, unknown>, order: string[] = []): Response {
  return new Response(
    JSON.stringify({
      models,
      agentModelSorts: order.length === 0 ? [] : [{ groups: [{ modelIds: order }] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("mergeAntigravityLists", () => {
  it("pools two accounts' lists, each in its own picker order", () => {
    const merged = mergeAntigravityLists([
      [{ id: "a" }, { id: "c" }],
      [{ id: "a" }, { id: "b" }, { id: "c" }],
    ]);
    expect(merged.map((model) => model.id)).toEqual(["a", "b", "c"]);
  });
});

describe("refreshAntigravityPool", () => {
  it("asks each account and keeps the merged pool", async () => {
    const dir = await tempDir();
    await saveSubscriptionAccounts(subscriptionAccountsFile(dir, "antigravity"), [
      account("one@example.test"),
    ]);
    const calls: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        answerWith(
          {
            "gemini-b": { maxTokens: 100_000, maxOutputTokens: 8_000 },
            "gemini-a": { maxTokens: 200_000, supportsImages: true },
          },
          ["gemini-a", "gemini-b"],
        ),
      );
    }) as typeof fetch;

    const pool = await refreshAntigravityPool(dir, { fetchImpl });

    expect(calls).toEqual([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    ]);
    expect(pool.pooled).toEqual([
      { id: "gemini-a", context: 200_000, images: true },
      { id: "gemini-b", context: 100_000, output: 8_000 },
    ]);
    expect(await loadAntigravityPool(dir)).toEqual(pool);
    expect(JSON.parse(await readFile(antigravityPoolFile(dir), "utf8"))).toEqual(pool);
  });

  it("keeps Gemini CLI's entries when it renews Antigravity's sign-in", async () => {
    const dir = await tempDir();
    await saveSubscriptionAccounts(subscriptionAccountsFile(dir, "antigravity"), [
      { ...account("one@example.test"), expiresAt: 0 },
      {
        agent: "gemini",
        id: "gemini:two@example.test",
        user: "two@example.test",
        plan: "Standard",
        addedAt: 1,
        lapsed: null,
        accessToken: "keep",
        refreshToken: "refresh",
        expiresAt: 0,
        project: null,
      },
    ]);
    const fetchImpl = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("fetchAvailableModels")) {
        return Promise.resolve(answerWith({ "gemini-a": {} }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "renewed", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    await refreshAntigravityPool(dir, { fetchImpl, tokenUrl: "https://token.example.test" });

    const stored = JSON.parse(
      await readFile(subscriptionAccountsFile(dir, "antigravity"), "utf8"),
    ) as { agent: string; accessToken: string }[];
    expect(stored.find((entry) => entry.agent === "gemini")?.accessToken).toBe("keep");
    expect(stored.find((entry) => entry.agent === "antigravity")?.accessToken).toBe("renewed");
  });

  it("keeps the list an account had when its fetch fails", async () => {
    const dir = await tempDir();
    await saveSubscriptionAccounts(subscriptionAccountsFile(dir, "antigravity"), [
      account("one@example.test"),
    ]);
    await refreshAntigravityPool(dir, {
      fetchImpl: (() => Promise.resolve(answerWith({ "gemini-a": {} }))) as typeof fetch,
    });

    const pool = await refreshAntigravityPool(dir, {
      fetchImpl: (() => Promise.resolve(new Response("no", { status: 500 }))) as typeof fetch,
    });

    expect(pool.accounts["one@example.test"]).toEqual([{ id: "gemini-a" }]);
    expect(pool.pooled).toEqual([{ id: "gemini-a" }]);
  });
});

describe("mergeAntigravityPoolIntoProvider", () => {
  const provider = (models: { id: string }[], agent?: string): GatewayProvider =>
    ({
      id: "google",
      protocol: "gemini",
      baseUrl: "https://example.test",
      models,
      accounts: [{ id: "main", weight: 1, priority: 0, enabled: true, models: [], agent }],
    }) as never;

  it("serves the pool's order, then a model the user added", () => {
    const merged = mergeAntigravityPoolIntoProvider(provider([{ id: "mine" }], "antigravity"), [
      { id: "b" },
      { id: "a", context: 100_000 },
    ]);
    expect(merged?.models).toEqual([
      { id: "b" },
      { id: "a", contextWindow: 100_000 },
      { id: "mine" },
    ]);
  });

  it("leaves a provider without an Antigravity sign-in alone", () => {
    expect(mergeAntigravityPoolIntoProvider(provider([], "gemini"), [{ id: "a" }])).toBeNull();
  });
});

describe("effectiveProviderModels", () => {
  const provider = (models: { id: string }[], agent?: string): GatewayProvider =>
    ({
      id: "google",
      protocol: "gemini",
      baseUrl: "https://example.test",
      models,
      accounts: [{ id: "main", weight: 1, priority: 0, enabled: true, models: [], agent }],
    }) as never;

  afterEach(() => resetAntigravityPool());

  it("serves the pool over the provider without writing its config", () => {
    setAntigravityPool({ accounts: {}, pooled: [{ id: "gemini-a", context: 100_000 }] });

    expect(effectiveProviderModels(provider([{ id: "mine" }], "antigravity"))).toEqual([
      { id: "gemini-a", contextWindow: 100_000 },
      { id: "mine" },
    ]);
  });

  it("leaves a provider without an Antigravity sign-in on its own models", () => {
    setAntigravityPool({ accounts: {}, pooled: [{ id: "gemini-a" }] });

    expect(effectiveProviderModels(provider([{ id: "mine" }], "gemini"))).toEqual([{ id: "mine" }]);
  });
});

describe("clearAntigravityPoolFromConfig", () => {
  it("removes what the pool wrote and keeps the user's own models", async () => {
    const initial = {
      providers: [
        {
          id: "google",
          protocol: "gemini",
          baseUrl: "https://example.test",
          models: [
            { id: "gemini-a" },
            { id: "gemini-b", contextWindow: 100_000 },
            { id: "mine" },
            { id: "gemini-c", label: "My name for it" },
          ],
          accounts: [
            { id: "main", weight: 1, priority: 0, enabled: true, models: [], agent: "antigravity" },
          ],
        },
        {
          id: "other",
          protocol: "openai",
          baseUrl: "https://example.test",
          models: [],
          accounts: [],
        },
      ],
    } as unknown as GatewayConfig;
    const write = vi.fn(async (next: GatewayConfig) => next);
    const store = { get: () => initial, write } as unknown as GatewayConfigStore;

    await clearAntigravityPoolFromConfig(store, [
      { id: "gemini-a" },
      { id: "gemini-b", context: 100_000 },
      { id: "gemini-c" },
    ]);

    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0]?.[0] as GatewayConfig;
    expect(written.providers[0]?.models).toEqual([
      { id: "mine" },
      { id: "gemini-c", label: "My name for it" },
    ]);
    expect(written.providers[1]).toBe(initial.providers[1]);
  });
});
