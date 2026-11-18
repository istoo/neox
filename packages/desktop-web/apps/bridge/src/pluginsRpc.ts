// Neox plugin management. The daemon's plugin host owns installation, enablement and the
// registry market; the bridge is a thin pass-through so the web UI can replace the fork's
// provider-plugin browser without inventing state.
import { NeolixPluginManifestContributions, WS_METHODS } from "@synara/contracts";
import type {
  NeolixPlugin,
  NeolixPluginContributions,
  NeolixPluginSettingsScreen,
} from "@synara/contracts";
import { Option, Schema } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { BridgeModel } from "./model.ts";
import { bridgeError, fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

const SETTINGS_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const FIELD_TYPES = new Set(["text", "number", "boolean", "select", "json"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSettingsScreen(value: unknown): value is NeolixPluginSettingsScreen {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.id)) return false;
  if (typeof value.title !== "string" || value.title.trim().length === 0) return false;
  if (typeof value.settingsId !== "string" || !SETTINGS_ID_PATTERN.test(value.settingsId)) {
    return false;
  }
  if (!Array.isArray(value.fields)) return false;
  return value.fields.every((fieldValue) => {
    if (!isRecord(fieldValue)) return false;
    if (typeof fieldValue.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldValue.key)) {
      return false;
    }
    if (typeof fieldValue.label !== "string") return false;
    if (typeof fieldValue.type !== "string" || !FIELD_TYPES.has(fieldValue.type)) return false;
    if (fieldValue.options !== undefined) {
      if (!Array.isArray(fieldValue.options)) return false;
      if (
        !fieldValue.options.every(
          (option) =>
            isRecord(option) &&
            typeof option.label === "string" &&
            typeof option.value === "string",
        )
      ) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Settings screens are declared in the plugin's `neox-plugin.json`. The daemon's schema
 * ignores the key (React Native plugins register screens from client code instead), so the
 * bridge reads the manifest directly and passes the declarations to the web settings shell.
 * debt: move this to a daemon-exposed contribution when `plugin.list` can carry it.
 */
async function readManifest(pluginPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(pluginPath, "neox-plugin.json"), "utf8"),
    );
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function settingsScreensFor(pluginPath: string): Promise<NeolixPluginSettingsScreen[]> {
  const raw = await readManifest(pluginPath);
  if (!raw || !Array.isArray(raw.settingsScreens)) return [];
  return raw.settingsScreens.filter(isSettingsScreen);
}

const decodeManifestContributions = Schema.decodeUnknownOption(NeolixPluginManifestContributions);

/**
 * Panel and row-action contributions that the daemon protocol does not carry. The React Native
 * host registers them from client code; the web host reads the same declarations from the
 * manifest so the surfaces exist without running the bundle.
 */
async function manifestContributionsFor(
  pluginPath: string,
): Promise<NeolixPluginManifestContributions | null> {
  const raw = await readManifest(pluginPath);
  if (!raw || !isRecord(raw.contributions)) return null;
  const decoded = decodeManifestContributions(raw.contributions);
  if (Option.isNone(decoded)) return null;
  const value = decoded.value;
  return Object.values(value).some((entry) => entry !== undefined) ? value : null;
}

async function withManifestContributions(plugin: NeolixPlugin): Promise<NeolixPlugin> {
  const [screens, extra] = await Promise.all([
    settingsScreensFor(plugin.path),
    manifestContributionsFor(plugin.path),
  ]);
  let contributions: NeolixPluginContributions | undefined = plugin.contributions;
  if (extra) contributions = { ...contributions, ...extra };
  if (screens.length === 0 && !extra) return plugin;
  return {
    ...plugin,
    ...(contributions ? { contributions } : {}),
    ...(screens.length > 0 ? { settingsScreens: screens } : {}),
  };
}

function settingsId(input: { readonly settingsId: string }): string {
  if (!SETTINGS_ID_PATTERN.test(input.settingsId)) {
    throw bridgeError(
      "plugin.settings-id-invalid",
      `Invalid plugin settings id: ${input.settingsId}`,
      { id: input.settingsId },
    );
  }
  return input.settingsId;
}

export function makePluginHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  return {
    [WS_METHODS.neolixPluginsList]: () =>
      fromPromise("neolix.plugins.list", async () => {
        // The daemon's wire type uses `unknown` for JSON payloads; the contracts use `Json`.
        const [plugins, daemonConfig] = await Promise.all([
          client.listPlugins(),
          Promise.resolve()
            .then(() => client.getDaemonConfig())
            .catch(() => null),
        ]);
        const withContributions = await Promise.all(
          (plugins as unknown as NeolixPlugin[]).map(withManifestContributions),
        );
        return {
          plugins: withContributions,
          ...(daemonConfig ? { pluginsEnabled: daemonConfig.config.pluginsEnabled === true } : {}),
        };
      }),

    [WS_METHODS.neolixPluginsBuiltin]: () =>
      fromPromise("neolix.plugins.builtin", async () => ({
        plugins: await client.listBuiltinPlugins(),
      })),

    [WS_METHODS.neolixPluginsMarket]: () =>
      fromPromise("neolix.plugins.market", () => client.getPluginMarket()),

    [WS_METHODS.neolixPluginsSearchMarket]: (payload) =>
      fromPromise("neolix.plugins.searchMarket", async () => {
        const input = payload as { query: string; mirror?: boolean };
        return {
          hits: await client.searchPluginMarket(
            input.query,
            input.mirror === true ? { mirror: true } : {},
          ),
        };
      }),

    [WS_METHODS.neolixPluginsInstall]: (payload) =>
      fromPromise("neolix.plugins.install", async () => {
        const input = payload as { source: string; id?: string; ref?: string };
        return {
          plugin: await client.installPluginSource({
            source: input.source,
            ...(input.id ? { id: input.id } : {}),
            ...(input.ref ? { ref: input.ref } : {}),
          }),
        };
      }),

    [WS_METHODS.neolixPluginsReload]: (payload) =>
      fromPromise("neolix.plugins.reload", async () => ({
        plugin: await client.reloadPlugin((payload as { pluginId: string }).pluginId),
      })),

    [WS_METHODS.neolixPluginsEnable]: (payload) =>
      fromPromise("neolix.plugins.enable", async () => ({
        plugin: await client.enablePlugin((payload as { pluginId: string }).pluginId),
      })),

    [WS_METHODS.neolixPluginsDisable]: (payload) =>
      fromPromise("neolix.plugins.disable", async () => ({
        plugin: await client.disablePlugin((payload as { pluginId: string }).pluginId),
      })),

    [WS_METHODS.neolixPluginsRemove]: (payload) =>
      fromPromise("neolix.plugins.remove", async () => {
        await client.removePlugin((payload as { pluginId: string }).pluginId);
        return {};
      }),

    [WS_METHODS.neolixPluginsLogs]: (payload) =>
      fromPromise("neolix.plugins.logs", async () => ({
        entries: await client.getPluginLogs((payload as { pluginId: string }).pluginId),
      })),

    [WS_METHODS.neolixPluginsReadme]: (payload) =>
      fromPromise("neolix.plugins.readme", async () => {
        const input = payload as { source: unknown; locale?: string };
        return {
          markdown: await client.getPluginReadme(input.source as never, input.locale),
        };
      }),

    [WS_METHODS.neolixProvidersInstalls]: () =>
      fromPromise("neolix.providers.installs", async () => {
        const result = await client.listAgentInstalls();
        return { entries: result.entries };
      }),

    [WS_METHODS.neolixProvidersRunInstall]: (payload) =>
      fromPromise("neolix.providers.runInstall", async () => {
        const input = payload as { provider: string; commandId: string };
        const result = await client.runAgentInstall({
          provider: input.provider,
          commandId: input.commandId,
        });
        return {
          provider: result.provider,
          ok: result.ok,
          exitCode: result.exitCode,
          output: result.output,
          error: result.error,
        };
      }),

    [WS_METHODS.neolixPluginsInvoke]: (payload) =>
      fromPromise("neolix.plugins.invoke", async () => {
        const input = payload as { pluginId: string; method: string; input?: unknown };
        return {
          output: await client.invokePluginRpc(input.pluginId, input.method, input.input ?? null),
        };
      }),

    // Plugin settings are ordinary plugin RPCs (`settings.<id>.read/write/reset`). The bridge
    // only pins the method format so a settings id can never select another plugin RPC.
    [WS_METHODS.neolixPluginsSettingsRead]: (payload) =>
      fromPromise("neolix.plugins.settings.read", async () => {
        const input = payload as { pluginId: string; settingsId: string };
        return client.invokePluginRpc(input.pluginId, `settings.${settingsId(input)}.read`, {});
      }),

    [WS_METHODS.neolixPluginsSettingsWrite]: (payload) =>
      fromPromise("neolix.plugins.settings.write", async () => {
        const input = payload as {
          pluginId: string;
          settingsId: string;
          revision: string;
          values: unknown;
        };
        return client.invokePluginRpc(input.pluginId, `settings.${settingsId(input)}.write`, {
          revision: input.revision,
          values: input.values,
        });
      }),

    [WS_METHODS.neolixPluginsSettingsReset]: (payload) =>
      fromPromise("neolix.plugins.settings.reset", async () => {
        const input = payload as { pluginId: string; settingsId: string; revision: string };
        return client.invokePluginRpc(input.pluginId, `settings.${settingsId(input)}.reset`, {
          revision: input.revision,
        });
      }),

    [WS_METHODS.neolixPluginsWebAsset]: (payload) =>
      fromPromise("neolix.plugins.webAsset", async () => {
        const input = payload as { pluginId: string; path: string };
        return client.getPluginWebAsset(input.pluginId, input.path);
      }),
  };
}
