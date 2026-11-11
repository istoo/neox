import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { makePluginHandlers } from "./pluginsRpc.ts";

const PLUGIN = {
  id: "usage-source",
  name: "Usage Source",
  path: "/plugins/usage-source",
  enabled: true,
  status: "running" as const,
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeHandlers(plugin: typeof PLUGIN & { settings?: unknown } = PLUGIN) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    listPlugins: async () => [plugin],
    listBuiltinPlugins: async () => ["claude-usage-source"],
    getPluginMarket: async () => ({
      registry: { name: "Neox", url: "https://plugins.example.com" },
      categories: [],
      plugins: [],
    }),
    searchPluginMarket: async (query: string, options: unknown) => {
      calls.push(["searchPluginMarket", { query, options }]);
      return [{ package: "neolix-plugin-x", name: "X" }];
    },
    installPluginSource: async (input: unknown) => {
      calls.push(["installPluginSource", input]);
      return PLUGIN;
    },
    reloadPlugin: async (pluginId: string) => {
      calls.push(["reloadPlugin", pluginId]);
      return PLUGIN;
    },
    enablePlugin: async (pluginId: string) => {
      calls.push(["enablePlugin", pluginId]);
      return PLUGIN;
    },
    disablePlugin: async (pluginId: string) => {
      calls.push(["disablePlugin", pluginId]);
      return { ...PLUGIN, enabled: false, status: "disabled" as const };
    },
    removePlugin: async (pluginId: string) => {
      calls.push(["removePlugin", pluginId]);
    },
    getPluginLogs: async (pluginId: string) => {
      calls.push(["getPluginLogs", pluginId]);
      return [
        { sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", stream: "stdout", message: "hi" },
      ];
    },
    invokePluginRpc: async (pluginId: string, method: string, input: unknown) => {
      calls.push(["invokePluginRpc", { pluginId, method, input }]);
      return { greeting: "hi" };
    },
    getPluginWebAsset: async (pluginId: string, assetPath: string) => {
      calls.push(["getPluginWebAsset", { pluginId, assetPath }]);
      return {
        pluginId,
        path: assetPath,
        contentType: "text/html" as const,
        encoding: "utf8" as const,
        content: "<p>hi</p>",
      };
    },
  } as unknown as DaemonClient;
  const model = { client } as unknown as BridgeModel;
  return { handlers: makePluginHandlers(model), calls };
}

describe("pluginsRpc", () => {
  it("lists installed and built-in plugins", async () => {
    const { handlers } = makeHandlers();
    await expect(
      Effect.runPromise(handlers[WS_METHODS.neolixPluginsList]!(undefined, undefined) as never),
    ).resolves.toEqual({
      plugins: [PLUGIN],
    });
    await expect(
      Effect.runPromise(handlers[WS_METHODS.neolixPluginsBuiltin]!(undefined, undefined) as never),
    ).resolves.toEqual({ plugins: ["claude-usage-source"] });
  });

  it("passes daemon settings descriptors through to the web host", async () => {
    const settings = [
      {
        id: "display",
        title: "Display",
        schema: { type: "object", properties: { enabled: { type: "boolean" } } },
      },
    ];
    const { handlers } = makeHandlers({ ...PLUGIN, settings });
    const result = (await Effect.runPromise(
      handlers[WS_METHODS.neolixPluginsList]!(undefined, undefined) as never,
    )) as { plugins: Array<{ settings?: unknown }> };

    expect(result.plugins[0]?.settings).toEqual(settings);
  });

  it("passes market search options through", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await Effect.runPromise(
      handlers[WS_METHODS.neolixPluginsSearchMarket]!(
        { query: "linter", mirror: true },
        undefined,
      ) as never,
    );
    expect(result).toEqual({ hits: [{ package: "neolix-plugin-x", name: "X" }] });
    expect(calls).toEqual([["searchPluginMarket", { query: "linter", options: { mirror: true } }]]);
  });

  it("installs a source and forwards the optional id/ref", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await Effect.runPromise(
      handlers[WS_METHODS.neolixPluginsInstall]!(
        { source: "owner/plugin", id: "usage-source", ref: "main" },
        undefined,
      ) as never,
    );
    expect(result).toEqual({ plugin: PLUGIN });
    expect(calls).toEqual([
      ["installPluginSource", { source: "owner/plugin", id: "usage-source", ref: "main" }],
    ]);
  });

  it("reloads, enables, disables, removes and reads logs", async () => {
    const { handlers, calls } = makeHandlers();
    const run = (key: string, payload?: unknown) =>
      Effect.runPromise(handlers[key]!(payload, undefined) as never);

    await run(WS_METHODS.neolixPluginsReload, { pluginId: "usage-source" });
    await run(WS_METHODS.neolixPluginsEnable, { pluginId: "usage-source" });
    const disabled = await run(WS_METHODS.neolixPluginsDisable, { pluginId: "usage-source" });
    await run(WS_METHODS.neolixPluginsRemove, { pluginId: "usage-source" });
    const logs = await run(WS_METHODS.neolixPluginsLogs, { pluginId: "usage-source" });

    expect(disabled).toMatchObject({ plugin: { enabled: false, status: "disabled" } });
    expect(logs).toMatchObject({ entries: [{ message: "hi" }] });
    expect(calls.map(([name]) => name)).toEqual([
      "reloadPlugin",
      "enablePlugin",
      "disablePlugin",
      "removePlugin",
      "getPluginLogs",
    ]);
  });

  it("invokes plugin RPC and reads declared web assets", async () => {
    const { handlers, calls } = makeHandlers();
    const run = (key: string, payload?: unknown) =>
      Effect.runPromise(handlers[key]!(payload, undefined) as never);

    const invoked = await run(WS_METHODS.neolixPluginsInvoke, {
      pluginId: "usage-source",
      method: "greet",
      input: { name: "Ada" },
    });
    const asset = await run(WS_METHODS.neolixPluginsWebAsset, {
      pluginId: "usage-source",
      path: "web/main.html",
    });

    expect(invoked).toEqual({ output: { greeting: "hi" } });
    expect(asset).toMatchObject({ contentType: "text/html", content: "<p>hi</p>" });
    expect(calls).toEqual([
      ["invokePluginRpc", { pluginId: "usage-source", method: "greet", input: { name: "Ada" } }],
      ["getPluginWebAsset", { pluginId: "usage-source", assetPath: "web/main.html" }],
    ]);
  });

  it("forwards the declared plugin settings RPCs", async () => {
    const { handlers, calls } = makeHandlers();
    const run = (key: string, payload?: unknown) =>
      Effect.runPromise(handlers[key]!(payload, undefined) as never);

    await run(WS_METHODS.neolixPluginsSettingsRead, {
      pluginId: "usage-source",
      settingsId: "display",
    });
    await run(WS_METHODS.neolixPluginsSettingsWrite, {
      pluginId: "usage-source",
      settingsId: "display",
      revision: "r1",
      values: { showMetadata: false },
    });
    await run(WS_METHODS.neolixPluginsSettingsReset, {
      pluginId: "usage-source",
      settingsId: "display",
      revision: "r1",
    });

    expect(calls).toEqual([
      ["invokePluginRpc", { pluginId: "usage-source", method: "settings.display.read", input: {} }],
      [
        "invokePluginRpc",
        {
          pluginId: "usage-source",
          method: "settings.display.write",
          input: { revision: "r1", values: { showMetadata: false } },
        },
      ],
      [
        "invokePluginRpc",
        {
          pluginId: "usage-source",
          method: "settings.display.reset",
          input: { revision: "r1" },
        },
      ],
    ]);

    await expect(
      run(WS_METHODS.neolixPluginsSettingsRead, {
        pluginId: "usage-source",
        settingsId: "__bad",
      }),
    ).rejects.toThrow("Invalid plugin settings id");
  });

  it("attaches settings screens declared in the plugin manifest", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-plugin-"));
    dirs.push(directory);
    const screens = [
      {
        id: "display",
        title: "Display",
        settingsId: "display",
        fields: [
          { key: "showMetadata", label: "Show metadata", type: "boolean" },
          {
            key: "groupBy",
            label: "Group by",
            type: "select",
            options: [{ label: "Project", value: "project" }],
          },
        ],
      },
    ];
    await fs.writeFile(
      path.join(directory, "neox-plugin.json"),
      JSON.stringify({ id: "usage-source", settingsScreens: screens }),
    );
    const { handlers } = makeHandlers({ ...PLUGIN, path: directory });

    const result = (await Effect.runPromise(
      handlers[WS_METHODS.neolixPluginsList]!(undefined, undefined) as never,
    )) as { plugins: Array<{ settingsScreens?: unknown }> };
    expect(result.plugins[0]?.settingsScreens).toEqual(screens);
  });

  it("attaches panel and row-action contributions declared in the plugin manifest", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-plugin-"));
    dirs.push(directory);
    const contributions = {
      workspacePanels: [
        {
          id: "review",
          title: "Review",
          context: "agent",
          locations: ["workspace", "explorer"],
          view: "main",
        },
      ],
      filePanels: [{ id: "pdf", title: "PDF", files: { extensions: ["pdf"] }, view: "main" }],
      providerActions: [
        {
          id: "check",
          title: "Check balance",
          action: { kind: "pluginRpc", method: "balance.check" },
        },
      ],
      providerPanels: [{ id: "balance", title: "Balance", view: "main" }],
      agentActions: [
        {
          id: "inspect",
          title: "Inspect",
          action: { kind: "openView", view: "main" },
        },
      ],
    };
    await fs.writeFile(
      path.join(directory, "neox-plugin.json"),
      JSON.stringify({ id: "usage-source", contributions }),
    );
    const { handlers } = makeHandlers({ ...PLUGIN, path: directory });

    const result = (await Effect.runPromise(
      handlers[WS_METHODS.neolixPluginsList]!(undefined, undefined) as never,
    )) as { plugins: Array<{ contributions?: unknown }> };
    expect(result.plugins[0]?.contributions).toEqual(contributions);
  });

  it("drops malformed manifest contributions instead of failing the list", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-plugin-"));
    dirs.push(directory);
    await fs.writeFile(
      path.join(directory, "neox-plugin.json"),
      JSON.stringify({
        id: "usage-source",
        contributions: { workspacePanels: [{ id: "broken" }] },
      }),
    );
    const { handlers } = makeHandlers({ ...PLUGIN, path: directory });

    const result = (await Effect.runPromise(
      handlers[WS_METHODS.neolixPluginsList]!(undefined, undefined) as never,
    )) as { plugins: Array<{ contributions?: unknown }> };
    expect(result.plugins[0]?.contributions).toBeUndefined();
  });
});
