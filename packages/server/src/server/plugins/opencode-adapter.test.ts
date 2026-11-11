import { describe, expect, it } from "vitest";
import type { PluginAccounts } from "@neolix/plugin/server/accounts";
import { openCodeSubscriptionProvider } from "@neolix/plugin/server/opencode";

function accountsOf(seed: Record<string, Record<string, unknown>> = {}): PluginAccounts {
  const map = new Map(Object.entries(seed));
  return {
    list: async () => [...map.keys()].sort(),
    read: async (id) => map.get(id) ?? null,
    write: async (id, auth) => {
      map.set(id, auth);
    },
    remove: async (id) => map.delete(id),
  };
}

async function adapter(accounts: PluginAccounts) {
  return openCodeSubscriptionProvider({
    accounts,
    id: "qoder",
    label: "Qoder",
    protocol: "openai",
    plugin: async ({ client }) => {
      await client.auth.set({
        path: { id: "qoder" },
        body: { type: "oauth", access: "old", refresh: "r1" },
      });
      return {
        auth: {
          methods: [
            {
              type: "oauth" as const,
              label: "Sign in with Qoder",
              prompts: [{ type: "text" as const, key: "team", message: "Team" }],
              authorize: async () => ({
                url: "https://signin.test/device",
                instructions: "approve the device",
                method: "auto",
                callback: async () => ({ type: "success", access: "new", refresh: "r2" }),
              }),
            },
          ],
          loader: async (getAuth) => {
            const auth = await getAuth();
            return {
              baseURL: "https://api.qoder.test/v1",
              apiKey: "key-1",
              fetch: async (url: string, init: { body: string }) =>
                new Response(JSON.stringify({ url, body: init.body, access: auth?.access }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
            };
          },
          usage: async (getAuth) => ({ access: (await getAuth())?.access }),
          checkin: async () => ({ outcome: "done" }),
          refresh: async (auth) => ({ access: `${String(auth.access)}-2` }),
        },
        config: (config: Record<string, unknown>) => {
          config.provider = {
            qoder: {
              models: {
                m1: { name: "M1", limit: { context: 1000, output: 100 }, reasoning: true },
              },
            },
          };
        },
        provider: {
          models: async (provider: Record<string, unknown>) => provider.models,
        },
      };
    },
  });
}

describe("openCodeSubscriptionProvider", () => {
  it("registers the community plugin's methods, models and loader", async () => {
    const accounts = accountsOf();
    const provider = await adapter(accounts);

    expect(provider).toMatchObject({
      id: "qoder",
      label: "Qoder",
      protocol: "openai",
    });
    expect(provider.methods[0]).toMatchObject({
      type: "oauth",
      label: "Sign in with Qoder",
      prompts: [{ type: "text", key: "team", message: "Team" }],
    });
    // The contribution wrote its sign-in through the account store client.
    await expect(accounts.read("qoder")).resolves.toEqual({
      type: "oauth",
      access: "old",
      refresh: "r1",
    });

    await expect(provider.models({ accountId: "qoder" })).resolves.toEqual([
      { id: "m1", name: "M1", context: 1000, maxOutput: 100, reasoning: true },
    ]);
    const loaded = await provider.loader({
      accountId: "qoder",
      model: "m1",
      body: {},
      headers: {},
    });
    expect(loaded).toMatchObject({
      baseUrl: "https://api.qoder.test/v1",
      headers: { authorization: "Bearer key-1" },
    });
    const response = await loaded.fetch?.("https://api.qoder.test/v1/chat/completions", {
      method: "POST",
      headers: {},
      body: '{"model":"m1"}',
    });
    await expect(response?.json()).resolves.toEqual({
      url: "https://api.qoder.test/v1/chat/completions",
      body: '{"model":"m1"}',
      access: "old",
    });
    await expect(provider.usage?.({ accountId: "qoder" })).resolves.toEqual({ access: "old" });
    await expect(provider.checkin?.({ accountId: "qoder" })).resolves.toEqual({ outcome: "done" });
  });

  it("turns the community device sign-in into a flow", async () => {
    const provider = await adapter(accountsOf());
    const outcome = await provider.methods[0]?.authorize?.({ team: "one" });
    expect(outcome).toMatchObject({
      url: "https://signin.test/device",
      instructions: "approve the device",
    });
    if (outcome === undefined || !("complete" in outcome)) throw new Error("no flow");
    await expect(outcome.complete()).resolves.toEqual({
      type: "oauth",
      access: "new",
      refresh: "r2",
    });
  });

  it("keeps a public API-key sign-in as api auth", async () => {
    const provider = await openCodeSubscriptionProvider({
      accounts: accountsOf(),
      id: "opencode-zen-free",
      label: "Zen Free",
      protocol: "openai",
      plugin: async () => ({
        auth: {
          methods: [
            {
              type: "api" as const,
              label: "Public",
              authorize: async (inputs: Record<string, string>) => ({
                type: "success",
                key: inputs.key,
              }),
            },
          ],
          loader: async () => ({ baseURL: "https://zen.test", apiKey: "public" }),
        },
      }),
    });
    await expect(provider.methods[0]?.authorize?.({ key: "public" })).resolves.toEqual({
      type: "api",
      key: "public",
    });
  });

  it("writes a refresh back into the account", async () => {
    const accounts = accountsOf({ qoder: { type: "oauth", access: "old" } });
    const provider = await adapter(accounts);
    await provider.refresh?.({ accountId: "qoder" });
    await expect(accounts.read("qoder")).resolves.toEqual({
      type: "oauth",
      access: "old-2",
      refresh: "r1",
    });
  });
});
