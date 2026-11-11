import { describe, expect, it, vi } from "vitest";
import {
  listAccountsViaDaemon,
  listPluginSubscriptionsViaDaemon,
  pluginSubscriptionModelsViaDaemon,
  pluginSubscriptionSignInPollViaDaemon,
  pluginSubscriptionSignInViaDaemon,
  removeAccountViaDaemon,
} from "./accounts-rpc.js";

const target = { kind: "instance", home: "/tmp/neolix-test" } as const;

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getLastServerInfoMessage: () => ({ features: { gatewaySubscriptionAccounts: true } }),
    listGatewaySubscriptionAccounts: vi.fn(async () => ({ requestId: "r", accounts: [] })),
    removeGatewaySubscriptionAccount: vi.fn(async () => ({ requestId: "r", ok: true })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("listAccountsViaDaemon", () => {
  it("asks the daemon and maps its redacted accounts to rows", async () => {
    const client = fakeClient({
      listGatewaySubscriptionAccounts: vi.fn(async () => ({
        requestId: "r",
        accounts: [
          {
            id: "gemini:one",
            agent: "gemini",
            user: "gem-one",
            alias: "Work",
            plan: "Standard",
            project: "my-project",
            addedAt: 1,
            lapsed: null,
          },
          {
            id: "copilot:two",
            agent: "copilot",
            user: "dev@example.test",
            plan: null,
            host: "acme.ghe.com",
            addedAt: 2,
            lapsed: "token revoked",
          },
        ],
      })),
    });
    const rows = await listAccountsViaDaemon(
      { target, connect: (async () => client) as never },
      undefined,
    );
    expect(rows).toEqual([
      {
        agent: "gemini",
        user: "gem-one",
        alias: "Work",
        plan: "Standard",
        project: "my-project",
        addedAt: 1,
      },
      {
        agent: "copilot",
        user: "dev@example.test",
        host: "acme.ghe.com",
        addedAt: 2,
        lapsed: "token revoked",
      },
    ]);
    expect(client.listGatewaySubscriptionAccounts).toHaveBeenCalledWith({});
    expect(client.close).toHaveBeenCalled();
  });

  it("reads the files when the daemon has no such RPC", async () => {
    const client = fakeClient({ getLastServerInfoMessage: () => ({ features: {} }) });
    const rows = await listAccountsViaDaemon(
      { target, connect: (async () => client) as never },
      "gemini",
    );
    expect(rows).toBeUndefined();
    expect(client.listGatewaySubscriptionAccounts).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it("reads the files when nothing answers", async () => {
    const rows = await listAccountsViaDaemon(
      {
        target,
        connect: (async () => {
          throw new Error("unreachable");
        }) as never,
      },
      undefined,
    );
    expect(rows).toBeUndefined();
  });
});

describe("removeAccountViaDaemon", () => {
  it("removes through the daemon", async () => {
    const client = fakeClient();
    expect(
      await removeAccountViaDaemon(
        { target, connect: (async () => client) as never },
        "gemini",
        "Work",
      ),
    ).toBe(true);
    expect(client.removeGatewaySubscriptionAccount).toHaveBeenCalledWith({
      agent: "gemini",
      user: "Work",
    });
  });

  it("returns false when the daemon holds no such account", async () => {
    const client = fakeClient({
      removeGatewaySubscriptionAccount: vi.fn(async () => ({ requestId: "r", ok: false })),
    });
    expect(
      await removeAccountViaDaemon(
        { target, connect: (async () => client) as never },
        "gemini",
        "nobody",
      ),
    ).toBe(false);
  });

  it("returns undefined when nothing answers", async () => {
    expect(
      await removeAccountViaDaemon(
        {
          target,
          connect: (async () => null) as never,
        },
        "gemini",
        "Work",
      ),
    ).toBeUndefined();
  });
});

describe("plugin subscriptions", () => {
  const features = { gatewayPluginSubscriptions: true };

  it("lists the providers running plugins declare", async () => {
    const client = fakeClient({
      getLastServerInfoMessage: () => ({ features }),
      getGatewayPluginSubscriptions: vi.fn(async () => ({
        requestId: "r",
        providers: [
          {
            pluginId: "qoder-auth",
            id: "qoder",
            label: "Qoder",
            protocol: "anthropic",
            methods: [{ type: "api", label: "API key" }],
          },
        ],
      })),
    });
    const answer = await listPluginSubscriptionsViaDaemon({
      target,
      connect: (async () => client) as never,
    });
    expect(answer?.providers).toEqual([
      {
        pluginId: "qoder-auth",
        id: "qoder",
        label: "Qoder",
        protocol: "anthropic",
        methods: [{ type: "api", label: "API key" }],
      },
    ]);
  });

  it("reads an account's models", async () => {
    const client = fakeClient({
      getLastServerInfoMessage: () => ({ features }),
      getGatewayPluginSubscriptionModels: vi.fn(async () => ({
        requestId: "r",
        models: [{ id: "m1", name: "M1" }],
      })),
    });
    const answer = await pluginSubscriptionModelsViaDaemon(
      { target, connect: (async () => client) as never },
      { pluginId: "qoder-auth", providerId: "qoder", accountId: "ann" },
    );
    expect(answer?.models).toEqual([{ id: "m1", name: "M1" }]);
  });

  it("runs a sign-in", async () => {
    const signIn = vi.fn(async () => ({
      requestId: "r",
      status: "signed_in" as const,
      auth: { access: "a" },
    }));
    const client = fakeClient({
      getLastServerInfoMessage: () => ({ features }),
      signInGatewayPluginSubscription: signIn,
    });
    const answer = await pluginSubscriptionSignInViaDaemon(
      { target, connect: (async () => client) as never },
      {
        pluginId: "qoder-auth",
        providerId: "qoder",
        method: 0,
        accountId: "ann",
        inputs: { key: "k" },
      },
    );
    expect(answer?.auth).toEqual({ access: "a" });
    expect(signIn).toHaveBeenCalledWith({
      pluginId: "qoder-auth",
      providerId: "qoder",
      method: 0,
      accountId: "ann",
      inputs: { key: "k" },
    });
  });

  it("polls a pending sign-in", async () => {
    const poll = vi.fn(async () => ({
      requestId: "r",
      status: "signed_in" as const,
      auth: { access: "a" },
    }));
    const client = fakeClient({
      getLastServerInfoMessage: () => ({ features }),
      pollGatewayPluginSubscriptionSignIn: poll,
    });
    const answer = await pluginSubscriptionSignInPollViaDaemon(
      { target, connect: (async () => client) as never },
      { pluginId: "qoder-auth", providerId: "qoder", token: "t1" },
    );
    expect(answer).toEqual({ requestId: "r", status: "signed_in", auth: { access: "a" } });
    expect(poll).toHaveBeenCalledWith({
      pluginId: "qoder-auth",
      providerId: "qoder",
      token: "t1",
    });
  });

  it("leaves a daemon without the feature to the caller", async () => {
    const client = fakeClient({ getLastServerInfoMessage: () => ({ features: {} }) });
    await expect(
      listPluginSubscriptionsViaDaemon({ target, connect: (async () => client) as never }),
    ).resolves.toBeUndefined();
  });
});
