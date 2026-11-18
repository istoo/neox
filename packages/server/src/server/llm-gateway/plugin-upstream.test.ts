import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import {
  runGatewayMiddlewareAccount,
  runGatewayMiddlewareEvent,
  runGatewayMiddlewareHeaders,
  runGatewayMiddlewareProvider,
  runGatewayMiddlewareRequest,
  setGatewayMiddlewareRunner,
  setPluginUpstreamResolver,
  type GatewayMiddlewareRunner,
} from "./plugin-upstream.js";
import { SubscriptionSkippedError } from "./subscription-upstream.js";
import { requestUpstream } from "./upstream.js";

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "qoder",
    protocol: "anthropic",
    baseUrl: "https://plugin.invalid",
    plugin: { pluginId: "qoder-auth", providerId: "qoder" },
    accounts: [],
    models: [],
    replyHeaders: [],
    passHeaders: [],
    countFree: false,
    ...overrides,
  } as GatewayProvider;
}

function account(overrides: Partial<GatewayAccount> = {}): GatewayAccount {
  return {
    id: "ann",
    enabled: true,
    priority: 0,
    weight: 1,
    models: [],
    ...overrides,
  } as GatewayAccount;
}

const releases: Array<() => void> = [];

/** A middleware runner with the hooks a test doesn't name doing nothing. */
function middlewareRunner(
  overrides: Partial<GatewayMiddlewareRunner> = {},
): GatewayMiddlewareRunner {
  return {
    active: () => true,
    hasHook: () => false,
    request: async () => null,
    response: async () => null,
    provider: async () => null,
    account: async () => false,
    event: async () => null,
    ...overrides,
  };
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
  setPluginUpstreamResolver(null);
  setGatewayMiddlewareRunner(null);
});

describe("a plugin-backed provider", () => {
  it("sends through the loader's address and headers, with its body", async () => {
    const seen: Array<{ url: string; authorization: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      seen.push({
        url: request.url ?? "",
        authorization: String(request.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let asked: Record<string, unknown> | undefined;
    releases.push(
      setPluginUpstreamResolver({
        load: async (input) => {
          asked = { ...input };
          return {
            baseUrl: `http://127.0.0.1:${port}/vendor`,
            headers: { authorization: "Bearer from-plugin", "x-signed": "yes" },
            body: { ...input.body, model: "vendor-model" },
          };
        },
        request: async () => {
          throw new Error("must not proxy without a token");
        },
      }),
    );
    try {
      const response = await requestUpstream({
        provider: provider(),
        account: account(),
        model: { id: "qoder-model" },
        body: { model: "qoder-model", max_tokens: 1, messages: [] },
        incomingHeaders: {},
      });
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(asked).toMatchObject({
      pluginId: "qoder-auth",
      providerId: "qoder",
      accountId: "ann",
      model: "qoder-model",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/vendor/messages");
    expect(seen[0]?.authorization).toBe("Bearer from-plugin");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ model: "vendor-model" });
  });

  it("is skipped while its plugin is not running", async () => {
    setPluginUpstreamResolver(null);
    await expect(
      requestUpstream({
        provider: provider(),
        model: { id: "m" },
        body: { model: "m" },
        incomingHeaders: {},
      }),
    ).rejects.toBeInstanceOf(SubscriptionSkippedError);
  });

  it("sends through the loader's own fetch when it gives one", async () => {
    let proxied: Record<string, unknown> | undefined;
    setPluginUpstreamResolver({
      load: async () => ({
        baseUrl: "https://vendor.test/v1",
        headers: {},
        token: "t1",
      }),
      request: async (input) => {
        proxied = { ...input };
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: Buffer.from('{"via":"plugin"}'),
        };
      },
    });
    const response = await requestUpstream({
      provider: provider(),
      account: account(),
      model: { id: "m" },
      body: { model: "m", stream: true },
      incomingHeaders: {},
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ via: "plugin" });
    expect(proxied).toMatchObject({
      pluginId: "qoder-auth",
      providerId: "qoder",
      token: "t1",
      url: "https://vendor.test/v1/messages",
      method: "POST",
    });
    expect(JSON.parse(String(proxied?.body))).toMatchObject({ model: "m" });
  });

  it("leaves an ordinary provider alone", async () => {
    let asked = false;
    setPluginUpstreamResolver({
      load: async () => {
        asked = true;
        throw new Error("must not be asked");
      },
      request: async () => {
        throw new Error("must not be asked");
      },
    });
    await expect(
      requestUpstream({
        provider: provider({ plugin: undefined, baseUrl: "http://127.0.0.1:1" }),
        model: { id: "m" },
        body: { model: "m" },
        incomingHeaders: {},
      }),
    ).rejects.toThrow();
    expect(asked).toBe(false);
  });
});

describe("plugin gateway middleware", () => {
  async function localProvider(): Promise<{
    provider: GatewayProvider;
    seen: Array<{ authorization: string; body: string }>;
    close: () => Promise<void>;
  }> {
    const seen: Array<{ authorization: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      seen.push({
        authorization: String(request.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer: "from-vendor" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      provider: provider({ plugin: undefined, baseUrl: `http://127.0.0.1:${port}` }),
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("reshapes the request going out and the answer coming back", async () => {
    const local = await localProvider();
    const calls: string[] = [];
    releases.push(
      setGatewayMiddlewareRunner(
        middlewareRunner({
          request: async (input) => {
            calls.push(`request:${input.providerId}:${input.model}`);
            return {
              ...input,
              body: { ...input.body, injected: true },
            };
          },
          response: async (input) => {
            calls.push(`response:${input.status}`);
            return {
              ...input,
              status: 202,
              headers: { ...input.headers, "x-rewritten": "yes" },
              body: JSON.stringify({ answer: "from-middleware" }),
            };
          },
        }),
      ),
    );
    try {
      const response = await requestUpstream({
        provider: local.provider,
        account: account(),
        model: { id: "m" },
        body: { model: "m", messages: [] },
        incomingHeaders: {},
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("x-rewritten")).toBe("yes");
      await expect(response.json()).resolves.toEqual({ answer: "from-middleware" });
    } finally {
      await local.close();
    }
    expect(calls).toEqual(["request:qoder:m", "response:200"]);
    expect(JSON.parse(local.seen[0]?.body ?? "{}")).toMatchObject({ injected: true });
  });

  it("leaves a streaming answer untouched while the request is still shaped", async () => {
    const local = await localProvider();
    let answered = false;
    releases.push(
      setGatewayMiddlewareRunner(
        middlewareRunner({
          request: async (input) => ({ ...input, body: { ...input.body, mw_request: true } }),
          response: async (input) => {
            answered = true;
            return { ...input, status: 202, body: "rewritten" };
          },
        }),
      ),
    );
    try {
      const response = await requestUpstream({
        provider: local.provider,
        account: account(),
        model: { id: "m" },
        body: { model: "m", stream: true, messages: [] },
        incomingHeaders: {},
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ answer: "from-vendor" });
    } finally {
      await local.close();
    }
    expect(answered).toBe(false);
    expect(JSON.parse(local.seen[0]?.body ?? "{}")).toMatchObject({ mw_request: true });
  });

  it("leaves the traffic alone when a middleware fails", async () => {
    const local = await localProvider();
    releases.push(
      setGatewayMiddlewareRunner(
        middlewareRunner({
          request: async () => {
            throw new Error("broken hook");
          },
          response: async () => {
            throw new Error("broken hook");
          },
        }),
      ),
    );
    try {
      const response = await requestUpstream({
        provider: local.provider,
        account: account(),
        model: { id: "m" },
        body: { model: "m", messages: [] },
        incomingHeaders: {},
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ answer: "from-vendor" });
    } finally {
      await local.close();
    }
    expect(JSON.parse(local.seen[0]?.body ?? "{}")).toMatchObject({ model: "m" });
  });

  it("passes the request key and returns a middleware's rejection", async () => {
    const seen: Array<string | undefined> = [];
    releases.push(
      setGatewayMiddlewareRunner(
        middlewareRunner({
          request: async (input) => {
            seen.push(input.requestKey);
            return { body: input.body, reject: { status: 418, message: "nope" } };
          },
        }),
      ),
    );
    await expect(
      runGatewayMiddlewareRequest({
        requestKey: "call-1",
        providerId: "qoder",
        protocol: "anthropic",
        model: "m",
        accountId: "",
        body: { model: "m" },
      }),
    ).resolves.toEqual({
      body: { model: "m" },
      reject: { status: 418, message: "nope" },
    });
    expect(seen).toEqual(["call-1"]);
  });

  it("collects the headers a plugin adds to one request", async () => {
    releases.push(
      setGatewayMiddlewareRunner(
        middlewareRunner({
          headers: async (input) => ({ headers: { "x-demo": input.providerId } }),
        }),
      ),
    );
    await expect(
      runGatewayMiddlewareHeaders({
        requestKey: "call-1",
        providerId: "qoder",
        protocol: "anthropic",
        model: "m",
        accountId: null,
      }),
    ).resolves.toEqual({ "x-demo": "qoder" });
  });

  it("runs the per-try hooks: body, account skip, and one event", async () => {
    releases.push(
      setGatewayMiddlewareRunner(
        middlewareRunner({
          hasHook: (hook) => hook === "event",
          provider: async (input) => ({ ...input, body: { ...input.body, perTry: true } }),
          account: async () => true,
          event: async (input) => ({ event: { ...(input.event as object), hooked: true } }),
        }),
      ),
    );
    const providerInput = {
      providerId: "qoder",
      protocol: "anthropic",
      model: "m",
      accountId: "ann",
      body: { model: "m" },
    };
    await expect(runGatewayMiddlewareProvider(providerInput)).resolves.toMatchObject({
      body: { model: "m", perTry: true },
    });
    await expect(
      runGatewayMiddlewareAccount({
        providerId: "qoder",
        protocol: "anthropic",
        model: "m",
        accountId: "ann",
      }),
    ).resolves.toBe(true);
    await expect(
      runGatewayMiddlewareEvent({
        providerId: "qoder",
        model: "m",
        accountId: "ann",
        event: { type: "text_delta", text: "hi" },
      }),
    ).resolves.toEqual({ event: { type: "text_delta", text: "hi", hooked: true } });
  });
});
