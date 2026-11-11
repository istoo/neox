import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileDirectoryPlugin } from "./compiler.js";
import { evaluateBundle } from "./bundle-evaluator.js";
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
    addHook(name: string, handler: HookCall["handler"]) {
      hooks.push({ name, handler });
      return () => undefined;
    },
  } as never);
  return hooks;
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

  it("rejects contributions it cannot run instead of ignoring them", async () => {
    const directory = await packageDirectory({
      ...DEMO_PACKAGE,
      "package.json": JSON.stringify({
        name: "@acme/tools-and-page",
        main: "index.mjs",
        magpie: { page: { title: "Notes", file: "page.html" }, search: { id: "web" } },
      }),
    });

    await expect(convertMynaPackage(directory)).rejects.toThrow(
      "contributes search, which Neox does not support yet",
    );
  });

  it("rejects runtime hooks other than tools", async () => {
    const directory = await packageDirectory({
      ...DEMO_PACKAGE,
      "index.mjs": `export async function Hooks() {
  return { tool: {}, provider: { id: "demo" } };
}`,
    });
    await convertMynaPackage(directory);
    const hooks = await loadPluginHooks(directory);
    const open = hooks.find((hook) => hook.name === "agent.open.before")!;

    await expect(open.handler({ request: { purpose: "interactive", tools: [] } })).rejects.toThrow(
      "contributes provider, which Neox cannot run yet",
    );
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

  it("converts a page-only package into a client plugin with myna's bridge", async () => {
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
    expect((await readPluginManifest(directory)).id).toBe("notes-page");

    const entry = await readFile(path.join(directory, "index.client.tsx"), "utf8");
    expect(entry).toContain("HtmlFrame");
    expect(entry).toContain('READS = ["providers:list","usage:summary"]');
    expect(entry).toContain("addSidebarHeaderItem");
    expect(entry).toContain("addProviderAction");
    expect(entry).toContain("addSettingsScreen");

    const serverEntry = await readFile(path.join(directory, "index.server.ts"), "utf8");
    expect(serverEntry).toContain("registerSettings");

    const pages = await readFile(path.join(directory, "client/myna-pages.ts"), "utf8");
    expect(pages).toContain("window.myna");
    expect(pages).toContain("data-myna=");
    expect(pages).toContain("body { background:");
    expect(pages).toContain("window.notes = true;");
    expect(pages).toContain("data:image/png;base64,");

    const bundles = await compileDirectoryPlugin(directory, "0.15.0");
    expect(bundles.clientBundle).toContain("myna");
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
    const bundles = await compileDirectoryPlugin(directory, "0.15.0");
    expect(bundles.serverBundle).toContain("registerSettings");
    expect(bundles.clientBundle).toContain("HtmlFrame");
  });

  it("evaluates the converted client contribution with myna's registrations", async () => {
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
          ],
        },
      }),
      "page.html": "<html><body>page</body></html>",
      "usage.html": "<html><body>usage</body></html>",
      "agents.html": "<html><body>agents</body></html>",
      "provider.html": "<html><body>provider</body></html>",
    });
    await convertMynaPackage(directory);
    const bundles = await compileDirectoryPlugin(directory, "0.15.0");
    if (!bundles.clientBundle) throw new Error("No client bundle");

    const registered: Record<string, unknown[]> = {};
    function record(kind: string, contribution: unknown) {
      (registered[kind] ??= []).push(contribution);
    }
    const clientRuntime = {
      defineTranslations: () => ({
        resources: {},
        message: (key: string) => key,
      }),
      useNeolix: () => ({}),
      useSettings: () => ({ status: "loading" }),
      useTranslation: () => ({ locale: "en", t: (key: string) => key }),
      getNeolixClient: () => ({}),
      useHosts: () => [],
      HtmlFrame: () => null,
      SidebarRow: () => null,
    };
    const factory = (globalThis.eval as (source: string) => unknown)(bundles.clientBundle);
    if (typeof factory !== "function") throw new Error("Client bundle is not executable");
    const module = (
      factory as (require: (name: string) => unknown) => {
        default(plugin: Record<string, unknown>): () => void;
      }
    )((name: string) => {
      if (name === "react") return { useRef: () => ({}), useMemo: (make: () => unknown) => make() };
      if (name === "react/jsx-runtime")
        return {
          jsx: (_type: unknown, props: unknown) => props,
          jsxs: (_type: unknown, props: unknown) => props,
        };
      if (name === "zod") {
        const json = {};
        return {
          z: { record: () => json, json: () => json, string: () => json },
          record: () => json,
          json: () => json,
          string: () => json,
        };
      }
      if (name === "@neolix/plugin") return { defineSettings: (value: unknown) => value };
      if (name === "@neolix/plugin/client") return clientRuntime;
      if (name === "@neolix/plugin/client/ui") return clientRuntime;
      throw new Error(`unexpected require: ${name}`);
    });
    module.default({
      addScreen: (contribution: unknown) => record("screens", contribution),
      addSettingsScreen: (contribution: unknown) => record("settingsScreens", contribution),
      addSidebarHeaderItem: (contribution: unknown) => record("headerItems", contribution),
      addSidebarFooterItem: (contribution: unknown) => record("footerItems", contribution),
      addProviderAction: (contribution: unknown) => record("providerActions", contribution),
      addProviderPanel: (contribution: unknown) => record("providerPanels", contribution),
      addAgentAction: (contribution: unknown) => record("agentActions", contribution),
    });

    expect(registered.screens?.map((entry) => (entry as { id: string }).id)).toEqual([
      "page",
      "panel-0",
      "panel-1",
    ]);
    expect(registered.settingsScreens?.map((entry) => (entry as { id: string }).id)).toEqual([
      "panel-0",
    ]);
    expect(registered.footerItems?.map((entry) => (entry as { id: string }).id)).toEqual([
      "panel-1",
    ]);
    expect(registered.providerPanels?.map((entry) => (entry as { id: string }).id)).toEqual([
      "panel-2",
    ]);
    expect(registered.providerActions?.map((entry) => (entry as { id: string }).id)).toEqual([
      "check",
    ]);
    expect(registered.agentActions?.map((entry) => (entry as { id: string }).id)).toEqual([
      "inspect",
    ]);
  });
});
