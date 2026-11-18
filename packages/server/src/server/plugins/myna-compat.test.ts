import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { compileDirectoryPlugin } from "./compiler.js";
import { evaluateBundle } from "./bundle-evaluator.js";
import { PluginService } from "./index.js";
import { assertDirectoryMynaSupport, convertMynaPackage, readMynaPackage } from "./myna-compat.js";
import { readPluginManifest } from "./manifest.js";

const directories: string[] = [];

async function packageDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "neolix-myna-"));
  directories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(path.join(directory, name), contents),
    ),
  );
  return directory;
}

const DEMO_PACKAGE = {
  "package.json": JSON.stringify({
    name: "@acme/tools-demo",
    description: "Demo myna tools",
    main: "index.mjs",
    magpie: {},
  }),
  "index.mjs": `export async function DemoTools() {
  return {
    tool: {
      add: {
        description: "Adds two numbers",
        args: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        execute({ a, b }) { return { sum: a + b }; },
      },
    },
  };
}`,
};

interface HookCall {
  name: string;
  handler: (input: { request: Record<string, unknown> }) => Promise<unknown>;
}

async function loadPluginHooks(directory: string): Promise<HookCall[]> {
  const bundles = await compileDirectoryPlugin(directory, "0.15.0");
  if (!bundles.serverBundle) throw new Error("No server bundle");
  const setup = evaluateBundle(bundles.serverBundle);
  const hooks: HookCall[] = [];
  await setup({
    accounts: {
      list: async () => [],
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined,
    },
    registerSettings: () => ({
      read: async () => ({ status: "invalid", revision: "0", error: "not used" }),
      subscribe: () => () => undefined,
    }),
    addHook(name: string, handler: HookCall["handler"]) {
      hooks.push({ name, handler });
      return () => undefined;
    },
  } as never);
  return hooks;
}

type RpcHandler = (input: unknown, context: { neolix: unknown }) => Promise<unknown>;

async function loadPluginRpcs(directory: string): Promise<Map<string, RpcHandler>> {
  const bundles = await compileDirectoryPlugin(directory, "0.15.0");
  if (!bundles.serverBundle) throw new Error("No server bundle");
  const setup = evaluateBundle(bundles.serverBundle);
  const handlers = new Map<string, RpcHandler>();
  await setup({
    registerSettings: () => ({
      read: async () => ({ status: "invalid", revision: "0", error: "not used" }),
      subscribe: () => () => undefined,
    }),
    handle(contract: { name: string }, handler: RpcHandler) {
      handlers.set(contract.name, handler);
    },
    addHook() {
      return () => undefined;
    },
  } as never);
  return handlers;
}

interface CapturedPlugin {
  hooks: HookCall[];
  middlewares: Array<{
    id: string;
    onRequest?(input: {
      body: Record<string, unknown>;
      [field: string]: unknown;
    }): Promise<unknown>;
    onProvider?(input: {
      body: Record<string, unknown>;
      [field: string]: unknown;
    }): Promise<unknown>;
    onAccount?(input: { accountId: string; [field: string]: unknown }): Promise<unknown>;
    onEvent?(input: { event: unknown; [field: string]: unknown }): Promise<unknown>;
    onResponse?(input: {
      body: string | null;
      status: number;
      [field: string]: unknown;
    }): Promise<unknown>;
    onHeaders?(input: {
      providerId: string;
      protocol: string;
      model: string;
      accountId: string | null;
      [field: string]: unknown;
    }): Promise<unknown>;
  }>;
  searchApis: Map<string, { id: string; execute(input: unknown): Promise<unknown> }>;
  subscriptionProviders: Map<
    string,
    {
      id: string;
      label: string;
      methods: unknown[];
      loader(input: unknown): Promise<unknown>;
      models(input: unknown): Promise<unknown>;
    }
  >;
  agentIntegrations: Map<
    string,
    {
      id: string;
      label: string;
      config: string;
      model?: string;
      connect(input: {
        gateway: { v1: string; key: string };
        model: string;
        models: string[];
      }): Promise<Record<string, unknown>>;
    }
  >;
  strategies: Map<string, { id: string; order(input: unknown): Promise<unknown> }>;
  usageObservers: Map<string, { id: string; onUsage(row: unknown): Promise<void> }>;
}

/** Runs a converted plugin's server entry against the context the daemon builds. */
async function loadPlugin(directory: string): Promise<CapturedPlugin> {
  const bundles = await compileDirectoryPlugin(directory, "0.15.0");
  if (!bundles.serverBundle) throw new Error("No server bundle");
  const setup = evaluateBundle(bundles.serverBundle);
  const captured: CapturedPlugin = {
    hooks: [],
    middlewares: [],
    searchApis: new Map(),
    subscriptionProviders: new Map(),
    agentIntegrations: new Map(),
    strategies: new Map(),
    usageObservers: new Map(),
  };
  await setup({
    accounts: {
      list: async () => [],
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined,
    },
    registerSettings: () => ({
      read: async () => ({ status: "invalid", revision: "0", error: "not used" }),
      subscribe: () => () => undefined,
    }),
    handle() {
      return () => undefined;
    },
    addHook(name: string, handler: HookCall["handler"]) {
      captured.hooks.push({ name, handler });
      return () => undefined;
    },
    registerSearchApi(api: CapturedPlugin["searchApis"] extends Map<string, infer T> ? T : never) {
      captured.searchApis.set(api.id, api);
    },
    registerSubscriptionProvider(
      provider: CapturedPlugin["subscriptionProviders"] extends Map<string, infer T> ? T : never,
    ) {
      captured.subscriptionProviders.set(provider.id, provider);
    },
    registerGatewayMiddleware(middleware: CapturedPlugin["middlewares"][number]) {
      captured.middlewares.push(middleware);
    },
    registerGatewayUsageObserver(
      observer: CapturedPlugin["usageObservers"] extends Map<string, infer T> ? T : never,
    ) {
      captured.usageObservers.set(observer.id, observer);
    },
    registerRoutingStrategy(
      strategy: CapturedPlugin["strategies"] extends Map<string, infer T> ? T : never,
    ) {
      captured.strategies.set(strategy.id, strategy);
    },
    registerAgentIntegration(
      integration: CapturedPlugin["agentIntegrations"] extends Map<string, infer T> ? T : never,
    ) {
      captured.agentIntegrations.set(integration.id, integration);
    },
    registerProvider() {
      return undefined;
    },
    registerUsageSource() {
      return undefined;
    },
  } as never);
  return captured;
}

function createConvertedService(home: string, pluginPath: string, pluginId: string): PluginService {
  const store = new DaemonConfigStore(home, {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    pluginsEnabled: true,
    plugins: { [pluginId]: { source: "directory", path: pluginPath } },
  });
  const service = new PluginService(pino({ level: "silent" }), store, "0.15.0", {
    settingsDirectory: path.join(home, "plugin-settings"),
  });
  service.bindNeolixSessionHost({
    async attachPluginSocket(_pluginId, socket) {
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.on("message", (data) => {
        if (typeof data !== "string") return;
        const message = JSON.parse(data);
        if (message.type !== "hello") return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "plugin-service-test",
                hostname: "plugin-service-test",
                version: "0.15.0",
                features: {},
              },
            },
          }),
        );
      });
      return { closed };
    },
  });
  return service;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("myna plugin conversion", () => {
  it("generates a Neox manifest and adapter that attach converted JSON Schema tools", async () => {
    const directory = await packageDirectory(DEMO_PACKAGE);

    const conversion = await convertMynaPackage(directory);

    expect(conversion).toEqual({ pluginId: "tools-demo", name: "@acme/tools-demo" });
    const manifest = await readPluginManifest(directory);
    expect(manifest.id).toBe("tools-demo");

    const hooks = await loadPluginHooks(directory);
    const open = hooks.find((hook) => hook.name === "agent.open.before");
    expect(open).toBeDefined();
    const result = (await open!.handler({
      request: { purpose: "interactive", tools: [], labels: {} },
    })) as { tools: { name: string; execute(input: unknown): Promise<unknown> }[] };

    expect(result.tools.map((tool) => tool.name)).toEqual(["tools_demo_add"]);
    await expect(result.tools[0]!.execute({ a: 1, b: 2 })).resolves.toEqual({
      text: JSON.stringify({ sum: 3 }),
      structuredContent: { sum: 3 },
    });
  });

  it("converts a magpie.middleware module into Neox gateway hooks", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/gateway-demo",
        magpie: { middleware: "gateway.mjs" },
      }),
      "gateway.mjs": `export function onRequest(body, ctx) {
  if (body.reject) {
    ctx.reject(418, "told no");
    return undefined;
  }
  if (ctx.state) ctx.state.seen = "yes";
  body.tagged = true;
  return body;
}
export function onProvider(body, ctx) {
  body.providerSeen = ctx.provider.id;
  body.stateSeen = ctx.state ? ctx.state.seen : undefined;
  return body;
}
export function onAccount(account) {
  return account.ref === "skip-me" ? { skip: true } : undefined;
}
export function onEvent(event) {
  if (event.drop) return null;
  event.seen = true;
  return event;
}
export function onResponse(body, ctx) {
  body.status = ctx.status;
  return body;
}
export const strategies = {
  reverse(pool, seats) {
    return seats.map((_seat, index) => index).reverse();
  },
};
export function onUsage(row) {
  globalThis.__mynaUsage = row;
}`,
    });

    await convertMynaPackage(directory);
    const plugin = await loadPlugin(directory);
    const middleware = plugin.middlewares.find((entry) => entry.id === "middleware")!;

    await expect(
      middleware.onRequest!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "acct",
        body: { model: "m" },
      }),
    ).resolves.toEqual({ body: { model: "m", tagged: true } });
    await expect(
      middleware.onProvider!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: null,
        state: { seen: "yes" },
        body: { model: "m" },
      }),
    ).resolves.toEqual({ body: { model: "m", providerSeen: "demo", stateSeen: "yes" } });
    // myna's ctx.reject ends the request with its status and message.
    await expect(
      middleware.onRequest!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "acct",
        body: { model: "m", reject: true },
      }),
    ).resolves.toEqual({ reject: { status: 418, message: "told no" } });
    await expect(
      middleware.onAccount!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "skip-me",
      }),
    ).resolves.toEqual({ skip: true });
    await expect(
      middleware.onAccount!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "keep-me",
      }),
    ).resolves.toBeUndefined();
    await expect(
      middleware.onEvent!({
        providerId: "demo",
        model: "m",
        accountId: "acct",
        event: { type: "text_delta" },
      }),
    ).resolves.toEqual({ event: { type: "text_delta", seen: true } });
    await expect(
      middleware.onEvent!({
        providerId: "demo",
        model: "m",
        accountId: "acct",
        event: { type: "text_delta", drop: true },
      }),
    ).resolves.toEqual({ event: null });
    await expect(
      middleware.onResponse!({
        providerId: "demo",
        model: "m",
        accountId: "acct",
        status: 200,
        headers: {},
        body: '{"ok":true}',
      }),
    ).resolves.toEqual({ body: '{"ok":true,"status":200}' });

    const strategy = plugin.strategies.get("reverse")!;
    await expect(
      strategy.order({
        pool: "group/x",
        seats: [{ key: "a" }, { key: "b" }, { key: "c" }],
        options: {},
      }),
    ).resolves.toEqual([2, 1, 0]);

    const observer = plugin.usageObservers.get("usage")!;
    await observer.onUsage({
      time: "2026-11-14T00:00:00.000Z",
      requested: "group/x",
      provider: "demo",
      account: "acct",
      model: "m",
      status: 200,
      inputTokens: 3,
      outputTokens: 4,
      durationMs: 12,
      costUsd: 0.5,
    });
    expect(globalThis.__mynaUsage).toMatchObject({
      time: Date.parse("2026-11-14T00:00:00.000Z"),
      provider: "demo",
      providerAccount: "acct",
      input: 3,
      output: 4,
      ms: 12,
      cost: 0.5,
    });
  });

  it("converts magpie.hooks into the gateway's asynchronous request hooks", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/hooks-demo",
        magpie: { hooks: "hooks.mjs" },
      }),
      "hooks.mjs": `export async function onRequest(body) {
  body.recalled = true;
  if (body.rewriteModel) body.model = "changed";
  return body;
}
export async function onResponse(reply) {
  reply.observed = true;
}`,
    });

    await convertMynaPackage(directory);
    const plugin = await loadPlugin(directory);
    const middleware = plugin.middlewares.find((entry) => entry.id === "hooks")!;

    await expect(
      middleware.onRequest!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "acct",
        body: { model: "m" },
      }),
    ).resolves.toEqual({ body: { model: "m", recalled: true } });
    // myna rolls a hook that changes the client's model or stream back.
    await expect(
      middleware.onRequest!({
        providerId: "demo",
        protocol: "openai",
        model: "other",
        accountId: "acct",
        body: { model: "other", rewriteModel: true },
      }),
    ).resolves.toBeUndefined();
    // A completion notification cannot rewrite the reply.
    await expect(
      middleware.onResponse!({
        providerId: "demo",
        model: "m",
        accountId: "acct",
        status: 200,
        headers: {},
        body: '{"ok":true}',
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a runtime hook it cannot run instead of ignoring it", async () => {
    const directory = await packageDirectory({
      ...DEMO_PACKAGE,
      "index.mjs": `export async function Hooks() {
  return { chat: { headers() {} } };
}`,
    });
    await convertMynaPackage(directory);

    await expect(loadPlugin(directory)).rejects.toThrow("contributes chat, which Neox cannot run");
  });

  it("converts the entry's search hook into a plugin search API", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/search-demo",
        main: "index.mjs",
        magpie: {},
      }),
      "index.mjs": `export async function Search() {
  return {
    search: {
      web: {
        name: "Web",
        keysURL: "https://example.com/keys",
        keyOptional: true,
        execute({ query, count }) {
          return { results: [{ title: query, url: "https://example.com", text: String(count) }] };
        },
      },
    },
  };
}`,
    });

    await convertMynaPackage(directory);
    const plugin = await loadPlugin(directory);
    const search = plugin.searchApis.get("web")!;

    expect(search).toMatchObject({
      id: "web",
      name: "Web",
      keysURL: "https://example.com/keys",
      keyOptional: true,
    });
    await expect(search.execute({ query: "neolix", key: null, url: null })).resolves.toEqual([
      { title: "neolix", url: "https://example.com", text: "6" },
    ]);
  });

  it("converts chat.headers into headers added to one request", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/headers-demo",
        main: "index.mjs",
        magpie: {},
      }),
      "index.mjs": `export async function Headers() {
  return {
    "chat.headers"(input, output) {
      output.headers["x-demo"] = input.provider.info.id;
    },
  };
}`,
    });

    await convertMynaPackage(directory);
    const plugin = await loadPlugin(directory);
    const middleware = plugin.middlewares.find((entry) => entry.id === "chat-headers")!;

    await expect(
      middleware.onHeaders!({
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: null,
      }),
    ).resolves.toEqual({ headers: { "x-demo": "demo" } });
  });

  it("converts the entry's auth and provider hooks into a subscription provider", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/provider-demo",
        main: "index.mjs",
        magpie: {},
      }),
      "index.mjs": `export async function Provider() {
  return {
    auth: {
      provider: "demo",
      methods: [{ type: "api", label: "API key" }],
      async loader() {
        return { baseURL: "https://demo.invalid/v1", headers: { "x-demo": "1" } };
      },
    },
    provider: {
      id: "demo",
      models() {
        return { fast: { name: "Demo Fast", limit: { context: 8000, output: 1000 } } };
      },
    },
    config(config) {
      config.provider = { demo: { name: "Demo", npm: "@ai-sdk/openai-compatible" } };
    },
  };
}`,
    });

    await convertMynaPackage(directory);
    const plugin = await loadPlugin(directory);
    const provider = plugin.subscriptionProviders.get("demo")!;

    expect(provider).toMatchObject({ id: "demo", label: "Demo" });
    expect(provider.methods).toHaveLength(1);
    await expect(provider.models({ accountId: "" })).resolves.toEqual([
      { id: "fast", name: "Demo Fast", context: 8000, maxOutput: 1000 },
    ]);
    await expect(
      provider.loader({ accountId: "", model: "fast", body: {}, headers: {} }),
    ).resolves.toEqual({
      baseUrl: "https://demo.invalid/v1",
      headers: { "x-demo": "1" },
    });
  });

  it("converts magpie.agent into an agent integration", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({ name: "@acme/agent-demo", magpie: { agent: "agent.mjs" } }),
      "agent.mjs": `export const agent = {
  id: "demo-agent",
  name: "Demo Agent",
  config: "~/.demo-agent/config.json",
  model: "model",
  prefix: "openai/",
};
export function connect({ gateway, model }) {
  return { "base-url": gateway.v1, "api-key": gateway.key, model };
}`,
    });

    await convertMynaPackage(directory);
    const plugin = await loadPlugin(directory);
    const integration = plugin.agentIntegrations.get("demo-agent")!;

    expect(integration).toMatchObject({
      id: "demo-agent",
      label: "Demo Agent",
      config: "~/.demo-agent/config.json",
    });
    // myna writes its prefix before the model; Neolix gets that value from connect.
    expect(integration.model).toBeUndefined();
    await expect(
      integration.connect({
        gateway: { v1: "http://127.0.0.1:6768/v1", key: "k" },
        model: "gpt",
        models: ["gpt"],
      }),
    ).resolves.toEqual({
      "base-url": "http://127.0.0.1:6768/v1",
      "api-key": "k",
      model: "openai/gpt",
    });
  });

  it("leaves ordinary packages and Neox plugins alone", async () => {
    const ordinary = await packageDirectory({ "package.json": '{"name":"plain"}' });
    const neolix = await packageDirectory({
      "package.json": '{"name":"already-neolix","magpie":{}}',
      "neox-plugin.json": '{"id":"already-neolix"}',
    });

    expect(await readMynaPackage(ordinary)).toBeNull();
    expect(await convertMynaPackage(ordinary)).toBeNull();
    expect(await convertMynaPackage(neolix)).toBeNull();
  });

  it("explains why a local myna directory cannot be installed in place", async () => {
    const directory = await packageDirectory(DEMO_PACKAGE);

    await expect(assertDirectoryMynaSupport(directory)).rejects.toThrow(
      "install it from npm or port it to a Neox plugin",
    );
  });

  it("converts a page-only package into a sandboxed web view and sidebar entry", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/notes-page",
        magpie: {
          page: {
            title: "Notes",
            titles: { zh: "笔记" },
            file: "page.html",
            replaces: "sessions",
          },
          panels: [{ slot: "settings", title: "Notes settings", file: "panel.html" }],
          actions: [{ id: "check", menu: "provider", title: "Check balance" }],
          permissions: ["providers:list", "usage:summary", "secrets:all"],
        },
      }),
      "page.html": `<!doctype html><html><head>
        <link rel="stylesheet" href="app.css">
        <script src="_myna/bridge.js"></script>
        <script src="app.js"></script>
      </head><body><h1>Notes</h1><img src="logo.png"></body></html>`,
      "panel.html": "<html><body><p>Panel</p></body></html>",
      "app.css": "body { background: url('bg.png'); }",
      "app.js": "window.notes = true;",
      "logo.png": "not-a-png",
      "bg.png": "not-a-png",
    });

    const conversion = await convertMynaPackage(directory);

    expect(conversion).toEqual({ pluginId: "notes-page", name: "@acme/notes-page" });
    const manifest = await readPluginManifest(directory);
    expect(manifest.id).toBe("notes-page");
    expect(manifest.web?.views).toEqual([
      {
        id: "page",
        title: "Notes",
        entry: "page.neolix.html",
        permissions: ["rpc"],
        rpcs: ["settings.options.read", "settings.options.write", "myna.read"],
      },
      {
        id: "panel-settings",
        title: "Notes settings",
        entry: "panel.neolix.html",
        permissions: ["rpc", "resize"],
        rpcs: ["settings.options.read", "settings.options.write", "myna.read"],
      },
    ]);
    expect(manifest.contributions?.sidebarItems).toEqual([
      { id: "page", title: "Notes", view: "page", section: "header", replaces: "sessions" },
    ]);
    expect(manifest.contributions?.panels).toEqual([
      {
        id: "panel-settings",
        slot: "settings",
        title: "Notes settings",
        view: "panel-settings",
      },
    ]);
    // Row actions are bridge-only manifest keys, so the daemon's schema strips them.
    const raw = JSON.parse(await readFile(path.join(directory, "neox-plugin.json"), "utf8")) as {
      contributions: { providerActions?: unknown[] };
    };
    expect(raw.contributions.providerActions).toEqual([
      {
        id: "check",
        title: "Check balance",
        action: { kind: "openView", view: "page", params: { action: "check" } },
      },
    ]);

    const page = await readFile(path.join(directory, "page.neolix.html"), "utf8");
    expect(page).toContain('src="/plugin-web/notes-page/neolix-myna/bridge.js"');
    expect(page).not.toContain("_myna/bridge.js");
    expect(page).toContain('src="app.js"');
    expect(page).toContain("body { background:");
    expect(page).toContain("data:image/png;base64,");

    const bridge = await readFile(path.join(directory, "neolix-myna/bridge.js"), "utf8");
    expect(bridge).toContain("window.myna = api");
    expect(bridge).toContain("settings.options.read");
    expect(bridge).toContain("myna.read");

    const serverEntry = await readFile(path.join(directory, "index.server.ts"), "utf8");
    expect(serverEntry).toContain("registerSettings");
    expect(serverEntry).toContain('READS = ["providers:list","usage:summary"]');
    expect(serverEntry).toContain('name: "myna.read"');

    expect(await readFile(path.join(directory, "index.client.tsx"), "utf8").catch(() => null)).toBe(
      null,
    );

    const bundles = await compileDirectoryPlugin(directory, "0.15.0");
    expect(bundles.clientBundle).toBeNull();
    expect(bundles.serverBundle).toContain("myna.read");
  });

  it("converts a panels-only package and keeps its actions off without a page", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/panel-only",
        magpie: {
          panels: [{ slot: "provider", title: "Balance", file: "panel.html" }],
          actions: [{ id: "check", menu: "provider", title: "Check balance" }],
          permissions: ["providers:list"],
        },
      }),
      "panel.html": "<html><body><p>Balance</p></body></html>",
    });

    await convertMynaPackage(directory);

    const manifest = await readPluginManifest(directory);
    expect(manifest.web?.views).toEqual([
      {
        id: "panel-provider",
        title: "Balance",
        entry: "panel.neolix.html",
        permissions: ["rpc", "resize"],
        rpcs: ["settings.options.read", "settings.options.write", "myna.read"],
      },
    ]);
    expect(manifest.contributions?.sidebarItems).toEqual([]);
    expect(manifest.contributions?.panels).toEqual([
      { id: "panel-provider", slot: "provider", title: "Balance", view: "panel-provider" },
    ]);
    const raw = JSON.parse(await readFile(path.join(directory, "neox-plugin.json"), "utf8")) as {
      contributions: { providerActions?: unknown[]; agentActions?: unknown[] };
    };
    expect(raw.contributions.providerActions).toEqual([]);
    expect(raw.contributions.agentActions).toEqual([]);

    const serverEntry = await readFile(path.join(directory, "index.server.ts"), "utf8");
    expect(serverEntry).toContain('READS = ["providers:list"]');
  });

  it("fails page conversion on a missing asset instead of shipping a broken page", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/broken-page",
        magpie: { page: { title: "Broken", file: "page.html" } },
      }),
      "page.html": '<html><head><script src="missing.js"></script></head></html>',
    });

    await expect(convertMynaPackage(directory)).rejects.toThrow(
      "myna page asset is missing: missing.js",
    );
  });

  it("registers options beside a converted host entry", async () => {
    const directory = await packageDirectory({
      ...DEMO_PACKAGE,
      "package.json": JSON.stringify({
        name: "@acme/tools-and-page",
        main: "index.mjs",
        magpie: {
          page: { title: "Tools", file: "page.html" },
          permissions: ["usage:summary"],
        },
      }),
      "page.html": "<html><body>tools</body></html>",
    });
    await convertMynaPackage(directory);

    const serverEntry = await readFile(path.join(directory, "index.server.ts"), "utf8");
    expect(serverEntry).toContain("registerSettings");
    expect(serverEntry).toContain('name: "myna.read"');
    const bundles = await compileDirectoryPlugin(directory, "0.15.0");
    expect(bundles.serverBundle).toContain("registerSettings");
    expect(bundles.serverBundle).toContain("PAGE_READ");
    expect(bundles.clientBundle).toBeNull();
  });

  it("declares row actions that reopen the page with the row they were picked on", async () => {
    const directory = await packageDirectory({
      "package.json": JSON.stringify({
        name: "@acme/actions-page",
        magpie: {
          page: { title: "Tools", file: "page.html" },
          panels: [
            { slot: "usage", title: "Tools usage", file: "usage.html" },
            { slot: "agents", title: "Tools agents", file: "agents.html" },
            { slot: "provider", title: "Tools provider", file: "provider.html" },
          ],
          actions: [
            { id: "check", menu: "provider", title: "Check balance" },
            { id: "inspect", menu: "agent", title: "Inspect" },
            { id: "2fa", menu: "agent", title: "Two factor" },
          ],
        },
      }),
      "page.html": "<html><body>page</body></html>",
      "usage.html": "<html><body>usage</body></html>",
      "agents.html": "<html><body>agents</body></html>",
      "provider.html": "<html><body>provider</body></html>",
    });
    await convertMynaPackage(directory);

    const manifest = await readPluginManifest(directory);
    expect(manifest.web?.views.map((view) => view.id)).toEqual([
      "page",
      "panel-usage",
      "panel-agents",
      "panel-provider",
    ]);
    expect(manifest.contributions?.panels).toEqual([
      { id: "panel-usage", slot: "usage", title: "Tools usage", view: "panel-usage" },
      { id: "panel-agents", slot: "agents", title: "Tools agents", view: "panel-agents" },
      { id: "panel-provider", slot: "provider", title: "Tools provider", view: "panel-provider" },
    ]);
    const raw = JSON.parse(await readFile(path.join(directory, "neox-plugin.json"), "utf8")) as {
      contributions: {
        providerActions?: { id: string; action: unknown }[];
        agentActions?: { id: string; action: unknown }[];
      };
    };
    expect(raw.contributions.providerActions?.map((entry) => entry.id)).toEqual(["check"]);
    expect(raw.contributions.agentActions?.map((entry) => entry.id)).toEqual([
      "inspect",
      "action-2fa",
    ]);
    expect(raw.contributions.providerActions?.[0]?.action).toEqual({
      kind: "openView",
      view: "page",
      params: { action: "check" },
    });
    expect(raw.contributions.agentActions?.[1]?.action).toEqual({
      kind: "openView",
      view: "page",
      params: { action: "2fa" },
    });
  });

  it("converts myna's example page into a view, sidebar row and read RPC", async () => {
    const source = fileURLToPath(new URL("./test-fixtures/myna-page-plugin", import.meta.url));
    const directory = await mkdtemp(path.join(tmpdir(), "neolix-myna-fixture-"));
    directories.push(directory);
    await cp(source, directory, { recursive: true });

    await convertMynaPackage(directory);

    const manifest = await readPluginManifest(directory);
    expect(manifest).toMatchObject({
      id: "usage-glance",
      web: {
        views: [
          {
            id: "page",
            title: "Usage glance",
            entry: "page/index.neolix.html",
            permissions: ["rpc"],
            rpcs: ["settings.options.read", "settings.options.write", "myna.read"],
          },
          {
            id: "panel-usage",
            title: "Usage glance panel",
            entry: "panel/index.neolix.html",
            permissions: ["rpc", "resize"],
            rpcs: ["settings.options.read", "settings.options.write", "myna.read"],
          },
        ],
      },
      contributions: {
        sidebarItems: [{ id: "page", title: "Usage glance", view: "page", section: "header" }],
        panels: [
          {
            id: "panel-usage",
            slot: "usage",
            title: "Usage glance panel",
            view: "panel-usage",
          },
        ],
      },
    });

    const page = await readFile(path.join(directory, "page/index.neolix.html"), "utf8");
    expect(page).toContain('src="app.js"');
    expect(page).toContain("--owl-font");
    expect(page).not.toContain("_owl/bridge.js");
    expect(page).toContain('src="/plugin-web/usage-glance/neolix-myna/bridge.js"');

    const panel = await readFile(path.join(directory, "panel/index.neolix.html"), "utf8");
    expect(panel).toContain('src="/plugin-web/usage-glance/neolix-myna/bridge.js"');
    expect(panel).not.toContain("_owl/bridge.js");
    expect(panel).toContain("font: 13px/1.45 system-ui, sans-serif;");

    const rpcs = await loadPluginRpcs(directory);
    const read = rpcs.get("myna.read");
    expect(read).toBeDefined();
    const neolix = {
      gateway: {
        providers: async () => [{ id: "claude", name: "Claude Code" }],
        usage: async () => ({
          report: {
            since: "2026-11-14T00:00:00.000Z",
            totals: {
              calls: 3,
              failed: 1,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 5,
              costUsd: 0.5,
            },
            byModel: [
              {
                id: "gpt",
                name: "GPT",
                calls: 2,
                inputTokens: 80,
                outputTokens: 10,
                costUsd: 0.25,
              },
            ],
          },
        }),
      },
    };

    await expect(
      read!({ name: "usage:summary", params: { period: "7d" } }, { neolix }),
    ).resolves.toEqual({
      period: "7d",
      since: "2026-11-14T00:00:00.000Z",
      calls: 3,
      errors: 1,
      input: 100,
      output: 20,
      cacheRead: 5,
      cost: 0.5,
      models: [{ model: "GPT", calls: 2, input: 80, output: 10, cost: 0.25 }],
    });
    await expect(read!({ name: "providers:list", params: {} }, { neolix })).rejects.toThrow(
      "this page cannot read providers:list",
    );
  });

  it("installs a converted contributor so its hooks, search, provider and agent are live", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "neolix-myna-home-"));
    const directory = await mkdtemp(path.join(tmpdir(), "neolix-myna-contrib-"));
    directories.push(home, directory);
    const source = fileURLToPath(
      new URL("./test-fixtures/myna-contribution-plugin", import.meta.url),
    );
    await cp(source, directory, { recursive: true });
    await convertMynaPackage(directory);

    const service = createConvertedService(home, directory, "myna-contrib-demo");
    await service.start();
    try {
      const listed = await service.listPlugins();
      expect(listed).toMatchObject([{ id: "myna-contrib-demo", status: "running" }]);
      expect(service.hasGatewayMiddlewares()).toBe(true);
      const request = await service.runGatewayMiddlewareRequest({
        requestKey: "call-1",
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "acct",
        body: { model: "m", marker: "kept" },
      });
      expect(request?.body).toMatchObject({ model: "m", recalled: true, middleware: "on" });
      const provider = await service.runGatewayMiddlewareProvider({
        requestKey: "call-1",
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: null,
        body: { model: "m" },
      });
      expect(provider?.body).toMatchObject({
        model: "m",
        provider: "demo",
        marker: "kept",
      });
      await expect(
        service.runGatewayMiddlewareAccount({
          providerId: "demo",
          protocol: "openai",
          model: "m",
          accountId: "skip-me",
        }),
      ).resolves.toBe(true);
      await expect(
        service.runGatewayMiddlewareEvent({
          providerId: "demo",
          model: "m",
          accountId: "acct",
          event: { type: "text_delta" },
        }),
      ).resolves.toEqual({ event: { type: "text_delta", seen: true } });
      const response = await service.runGatewayMiddlewareResponse({
        requestKey: "call-1",
        providerId: "demo",
        model: "m",
        accountId: "acct",
        status: 200,
        headers: {},
        body: '{"ok":true}',
      });
      expect(JSON.parse(response!.body!)).toEqual({ ok: true, status: 200, marker: "kept" });
      // The response ended that call: its state is released.
      const afterRelease = await service.runGatewayMiddlewareProvider({
        requestKey: "call-1",
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: null,
        body: { model: "m" },
      });
      expect(afterRelease?.body).toMatchObject({ marker: null });

      // myna's ctx.reject ends the request with its status and message.
      const rejected = await service.runGatewayMiddlewareRequest({
        requestKey: "call-2",
        providerId: "demo",
        protocol: "openai",
        model: "m",
        accountId: "acct",
        body: { model: "m", rejectWith: 418, rejectMessage: "told no" },
      });
      expect(rejected?.reject).toEqual({ status: 418, message: "told no" });

      await expect(
        service.runGatewayMiddlewareHeaders({
          requestKey: "call-2",
          providerId: "demo",
          protocol: "openai",
          model: "m",
          accountId: null,
        }),
      ).resolves.toEqual({ headers: { "x-myna-demo": "demo" } });

      expect(service.routingStrategiesOf("myna-contrib-demo")).toEqual(["reverse"]);
      const seats = [
        { key: "a", provider: "demo", model: "a", priority: 0, weight: 1, resting: false },
        { key: "b", provider: "demo", model: "b", priority: 0, weight: 1, resting: false },
        { key: "c", provider: "demo", model: "c", priority: 0, weight: 1, resting: false },
      ];
      await expect(
        service.runRoutingStrategy("myna-contrib-demo/reverse", {
          pool: "group/x",
          seats,
          options: {},
        }),
      ).resolves.toEqual([2, 1, 0]);

      expect(service.listSearchApis()).toContainEqual({
        vendor: "plugin:myna-contrib-demo:web",
        name: "Demo search",
        keysURL: "https://example.com/keys",
        keyOptional: true,
      });
      await expect(
        service.executeSearchApi("plugin:myna-contrib-demo:web", {
          query: "neolix",
          key: null,
          url: null,
        }),
      ).resolves.toEqual([
        { title: "Result for neolix", url: "https://example.com/neolix", text: "6 pages" },
      ]);

      expect(service.listSubscriptionProviders()).toContainEqual(
        expect.objectContaining({
          pluginId: "myna-contrib-demo",
          id: "demo",
          label: "Demo",
          protocol: "openai",
        }),
      );
      await expect(service.subscriptionModels("myna-contrib-demo", "demo", "")).resolves.toEqual([
        { id: "fast", name: "Demo Fast", context: 8000, maxOutput: 1000 },
      ]);

      expect(service.listAgentIntegrations()).toContainEqual(
        expect.objectContaining({
          pluginId: "myna-contrib-demo",
          id: "demo-agent",
          label: "Demo Agent",
          config: "~/.demo-agent/config.json",
        }),
      );
      await expect(
        service.wireAgentIntegration("myna-contrib-demo", "demo-agent", {
          gateway: { v1: "http://127.0.0.1:6768/v1", key: "k" },
          model: "gpt",
          models: ["gpt"],
        }),
      ).resolves.toEqual({
        "base-url": "http://127.0.0.1:6768/v1",
        "api-key": "k",
        model: "openai/gpt",
      });
    } finally {
      await service.stopAllPlugins();
    }
  }, 30_000);
});
