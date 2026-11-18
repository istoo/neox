import type { PluginAgentToolsRuntime } from "./agent-tools.js";
import type { PluginLifecycle } from "./lifecycle/index.js";
import path from "node:path";
import { stat, rm, readFile, realpath } from "node:fs/promises";
import type pino from "pino";
import type { ProviderRegistration } from "@neolix/plugin/server/provider";
import {
  PluginIdSchema,
  type PluginLogEntry,
  type PluginListItem,
  type PluginSource,
  type PluginSourceStatusItem,
  type PluginSourceUpdateItem,
  type PluginUpdateSelection,
  type PluginUpdateProposal,
  type PluginUpdatePreview,
  type PluginUpdateResult,
  type PluginWebAssetContentType,
} from "@neolix/protocol/messages";
import { parsePluginSourceReference } from "@neolix/protocol/plugin-source-reference";
import { assertPluginCompatibility } from "@neolix/protocol/plugin-requirements";
import { BUILTIN_PROVIDER_IDS } from "@neolix/protocol/provider-manifest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { type ManagedPluginCandidate, ManagedPluginSources } from "./managed-source.js";
import { readPluginManifest } from "./manifest.js";
import { assertDirectoryMynaSupport } from "./myna-compat.js";
import { expandTilde } from "../../utils/path.js";
import { runPluginBuild } from "./preparation.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginRuntimeSubscription } from "./runtime-subscription.js";
import { BuiltinPluginLoader, type BuiltinPlugin } from "./builtin/index.js";
import { loadPluginMarket, searchNpmPlugins, type PluginMarketOptions } from "./market.js";
import { loadPluginReadme } from "./readme.js";
import type { PluginReadmeSource } from "@neolix/protocol/messages";
import type { PluginProviderMetadata } from "./plugin-process-protocol.js";
import { readPluginProviderIcon } from "./provider-icon.js";
import {
  type AgentUsageLookup,
  type ListUsageReportsOptions,
  UsageSourceRegistry,
} from "./usage-sources/index.js";
import type { PluginUsageSourceMetadata } from "./plugin-process-protocol.js";
import type { SubscriptionLoaderInput } from "@neolix/plugin/server/subscription";

const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS);
const PLUGIN_WEB_ASSET_MAX_BYTES = 2 * 1024 * 1024;

const WEB_ASSET_CONTENT_TYPES: Readonly<Record<string, PluginWebAssetContentType>> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
};

function webAssetContentType(assetPath: string): PluginWebAssetContentType | null {
  return WEB_ASSET_CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ?? null;
}

/**
 * Reads one declared web asset from a plugin package. Paths come from the request schema, which
 * already rejects traversal and absolute paths; the resolved path is checked again against the
 * package directory so a symlinked checkout cannot escape it.
 */
export async function readPluginWebAssetFile(
  directory: string,
  assetPath: string,
): Promise<{
  path: string;
  contentType: PluginWebAssetContentType;
  encoding: "utf8" | "base64";
  content: string;
}> {
  const contentType = webAssetContentType(assetPath);
  if (!contentType) throw new Error(`Unsupported plugin web asset: ${assetPath}`);
  const root = await realpath(path.resolve(directory));
  const resolved = path.resolve(root, assetPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Plugin web asset escapes its package: ${assetPath}`);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin web asset is missing: ${assetPath}`);
  // Follow symlinks once and re-check, so a link inside the package cannot point outside it.
  const realResolved = await realpath(resolved);
  const realRelative = path.relative(root, realResolved);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative))
    throw new Error(`Plugin web asset escapes its package: ${assetPath}`);
  if (info.size > PLUGIN_WEB_ASSET_MAX_BYTES)
    throw new Error(`Plugin web asset is too large: ${assetPath}`);
  const bytes = await readFile(resolved);
  const binary =
    contentType === "image/png" || contentType === "image/jpeg" || contentType === "font/woff2";
  return {
    path: assetPath,
    contentType,
    encoding: binary ? "base64" : "utf8",
    content: binary ? bytes.toString("base64") : bytes.toString("utf8"),
  };
}

interface PluginRuntimePort {
  subscribeSessionOpenChanges?: PluginRuntime["subscribeSessionOpenChanges"];
  isToolPluginAvailable?: PluginRuntime["isToolPluginAvailable"];
  callTool?: PluginRuntime["callTool"];
  detachTools?: PluginRuntime["detachTools"];
  emit?: PluginLifecycle["emit"];
  drainEvents?: PluginRuntime["drainEvents"];
  before?: PluginLifecycle["before"];
  wait?: PluginLifecycle["wait"];
  catalog: PluginRuntime["catalog"];
  invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
  startSubscription: PluginRuntime["startSubscription"];
  getLogs(pluginId: string): PluginLogEntry[];
  clearLogs(pluginId: string): void;
  getProviderRegistrations?(pluginId: string): readonly PluginProviderMetadata[];
  getSettingsRegistrations?(
    pluginId: string,
  ): readonly { id: string; title?: string; schema?: Record<string, unknown> }[];
  getUsageSourceRegistrations(pluginId: string): readonly PluginUsageSourceMetadata[];
  loadSubscription?: PluginRuntime["loadSubscription"];
  proxySubscription?: PluginRuntime["proxySubscription"];
  allSubscriptionProviders?: PluginRuntime["allSubscriptionProviders"];
  subscriptionModels?: PluginRuntime["subscriptionModels"];
  subscriptionSignIn?: PluginRuntime["subscriptionSignIn"];
  subscriptionSignInPoll?: PluginRuntime["subscriptionSignInPoll"];
  subscriptionCheckin?: PluginRuntime["subscriptionCheckin"];
  hasGatewayMiddlewares?: PluginRuntime["hasGatewayMiddlewares"];
  runGatewayMiddlewareRequest?: PluginRuntime["runGatewayMiddlewareRequest"];
  runGatewayMiddlewareResponse?: PluginRuntime["runGatewayMiddlewareResponse"];
  runGatewayMiddlewareProvider?: PluginRuntime["runGatewayMiddlewareProvider"];
  runGatewayMiddlewareAccount?: PluginRuntime["runGatewayMiddlewareAccount"];
  runGatewayMiddlewareEvent?: PluginRuntime["runGatewayMiddlewareEvent"];
  runGatewayMiddlewareHeaders?: PluginRuntime["runGatewayMiddlewareHeaders"];
  hasGatewayMiddlewareHook?: PluginRuntime["hasGatewayMiddlewareHook"];
  hasGatewayUsageObservers?: PluginRuntime["hasGatewayUsageObservers"];
  observeGatewayUsage?: PluginRuntime["observeGatewayUsage"];
  routingStrategiesOf?: PluginRuntime["routingStrategiesOf"];
  runRoutingStrategy?: PluginRuntime["runRoutingStrategy"];
  listAgentIntegrations?: PluginRuntime["listAgentIntegrations"];
  wireAgentIntegration?: PluginRuntime["wireAgentIntegration"];
  allSearchApis(): ReturnType<PluginRuntime["allSearchApis"]>;
  executeSearch: PluginRuntime["executeSearch"];
  fetchUsage: PluginRuntime["fetchUsage"];
  discoverUsage: PluginRuntime["discoverUsage"];
  connectProvider: PluginRuntime["connectProvider"];
  getProviderCatalogCacheKey?: PluginRuntime["getProviderCatalogCacheKey"];
  getProviderStatus?: PluginRuntime["getProviderStatus"];
  validatePlugin?(path: string): Promise<void>;
  startPlugin(pluginId: string, path: string, canPublish: () => boolean): Promise<void>;
  startBuiltinPlugin?(plugin: BuiltinPlugin): Promise<void>;
  stopPluginById(pluginId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (pluginId: string, error?: string) => void): () => void;
  bindNeolixSessionHost(sessionHost: Parameters<PluginRuntime["bindNeolixSessionHost"]>[0]): void;
}

interface PluginServiceDependencies {
  usageAgents?: AgentUsageLookup;
  settingsDirectory?: string;
  runtime?: PluginRuntimePort;
  managedSources?: ManagedPluginSources;
  builtinPlugins?: BuiltinPluginLoader;
  market?: PluginMarketOptions;
}

function resolvePluginStatus(input: {
  enabled: boolean;
  globallyEnabled: boolean;
  running: boolean;
}): PluginListItem["status"] {
  if (!input.enabled || !input.globallyEnabled) return "disabled";
  return input.running ? "running" : "failed";
}

export class PluginService {
  private readonly runtime: PluginRuntimePort;
  private readonly managedSources: ManagedPluginSources | null;
  private readonly builtinPluginIds: ReadonlySet<string>;
  private readonly builtinPlugins: BuiltinPluginLoader;
  private readonly logger: pino.Logger;
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<(pluginId: string) => void>();
  private readonly providers = new Map<string, ProviderRegistration>();
  private readonly usageSources: UsageSourceRegistry;
  private readonly usageSourceIdsByPlugin = new Map<string, string[]>();
  private readonly providerIdsByPlugin = new Map<string, readonly string[]>();
  private readonly providerListeners = new Set<() => void>();
  private lifecycle = Promise.resolve();
  private globalStartsBlocked = true;
  private readonly pendingOperations = new Map<
    string,
    { kind: "disable" | "remove"; completion: Promise<void> }
  >();
  private started = false;
  private readonly settingsListeners = new Set<(pluginId: string, settingsId: string) => void>();

  constructor(
    logger: pino.Logger,
    private readonly configStore: DaemonConfigStore,
    private readonly daemonVersion: string,
    private readonly dependencies: PluginServiceDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugin-service" });
    this.usageSources = new UsageSourceRegistry(
      Date.now,
      300_000,
      this.logger,
      dependencies.usageAgents,
    );
    this.runtime =
      dependencies.runtime ??
      new PluginRuntime(logger, daemonVersion, {
        settingsDirectory: dependencies.settingsDirectory,
        onSettingsChanged: (pluginId, settingsId) => {
          for (const listener of this.settingsListeners) listener(pluginId, settingsId);
        },
      });
    this.managedSources = dependencies.managedSources ?? null;
    this.builtinPlugins = dependencies.builtinPlugins ?? new BuiltinPluginLoader(undefined, []);
    this.builtinPluginIds = this.builtinPlugins.ids;
    this.runtime.subscribe((pluginId, error) => {
      this.removeProviderRegistrations(pluginId);
      this.removeUsageSources(pluginId);
      if (error) this.errors.set(pluginId, error);
      this.notify(pluginId);
    });
  }

  readonly emit: PluginLifecycle["emit"] = (name, event) => {
    this.runtime.emit?.(name, event);
  };

  subscribeSessionOpenChanges(listener: () => void): () => void {
    return this.runtime.subscribeSessionOpenChanges?.(listener) ?? (() => {});
  }

  readonly isToolPluginAvailable: PluginAgentToolsRuntime["isToolPluginAvailable"] = (
    pluginId,
    pluginInstanceId,
  ) => {
    return this.runtime.isToolPluginAvailable?.(pluginId, pluginInstanceId) ?? false;
  };

  readonly detachTools: PluginAgentToolsRuntime["detachTools"] = (agentId) => {
    this.runtime.detachTools?.(agentId);
  };

  readonly callTool: PluginAgentToolsRuntime["callTool"] = async (
    pluginId,
    pluginInstanceId,
    agent,
    name,
    input,
    signal,
  ) => {
    if (!this.isToolPluginAvailable(pluginId, pluginInstanceId) || !this.runtime.callTool)
      return { isError: true, text: `Plugin is not available: ${pluginId}` };
    return this.runtime.callTool(pluginId, pluginInstanceId, agent, name, input, signal);
  };

  readonly wait: PluginLifecycle["wait"] = async (name, payload) => {
    await this.runtime.wait?.(name, payload);
  };

  async drainEvents(): Promise<void> {
    await this.runtime.drainEvents?.();
  }

  readonly before: PluginLifecycle["before"] = async (name, request) => {
    if (this.runtime.before) {
      return this.runtime.before(name, request);
    }
    return request;
  };

  subscribeSettings(listener: (pluginId: string, settingsId: string) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  subscribe(listener: (pluginId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bindNeolixSessionHost(sessionHost: Parameters<PluginRuntime["bindNeolixSessionHost"]>[0]): void {
    this.runtime.bindNeolixSessionHost(sessionHost);
  }

  /** Which configured plugin registered which agent providers. */
  getProviderContributions(): Array<{ pluginId: string; providers: string[] }> {
    return [...this.providerIdsByPlugin.entries()].map(([pluginId, providers]) => ({
      pluginId,
      providers: [...providers],
    }));
  }

  getProviderRegistrations(): readonly ProviderRegistration[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** A plugin subscription provider's loader, for one gateway attempt. */
  loadSubscription(
    pluginId: string,
    providerId: string,
    input: SubscriptionLoaderInput,
  ): Promise<{ baseUrl: string; headers: Record<string, string>; token?: string }> {
    if (this.runtime.loadSubscription === undefined) {
      throw new Error("Plugin subscriptions are unavailable");
    }
    return this.runtime.loadSubscription(pluginId, providerId, input);
  }

  /** One request through a plugin loader's own fetch. */
  proxySubscription(
    pluginId: string,
    providerId: string,
    input: Parameters<PluginRuntime["proxySubscription"]>[2],
  ): ReturnType<PluginRuntime["proxySubscription"]> {
    if (this.runtime.proxySubscription === undefined) {
      throw new Error("Plugin subscriptions are unavailable");
    }
    return this.runtime.proxySubscription(pluginId, providerId, input);
  }

  /** Every running plugin's subscription providers. */
  listSubscriptionProviders(): ReturnType<PluginRuntime["allSubscriptionProviders"]> {
    return this.runtime.allSubscriptionProviders?.() ?? [];
  }

  subscriptionModels(
    pluginId: string,
    providerId: string,
    accountId: string,
  ): ReturnType<PluginRuntime["subscriptionModels"]> {
    if (this.runtime.subscriptionModels === undefined) {
      throw new Error("Plugin subscriptions are unavailable");
    }
    return this.runtime.subscriptionModels(pluginId, providerId, accountId);
  }

  subscriptionSignIn(
    pluginId: string,
    providerId: string,
    method: number,
    accountId: string,
    inputs: Record<string, string>,
  ): ReturnType<PluginRuntime["subscriptionSignIn"]> {
    if (this.runtime.subscriptionSignIn === undefined) {
      throw new Error("Plugin subscriptions are unavailable");
    }
    return this.runtime.subscriptionSignIn(pluginId, providerId, method, accountId, inputs);
  }

  /** Asks a plugin to check one account in, as its `auth.checkin` does. */
  subscriptionCheckin(
    pluginId: string,
    providerId: string,
    accountId: string,
  ): ReturnType<PluginRuntime["subscriptionCheckin"]> {
    if (this.runtime.subscriptionCheckin === undefined) {
      return Promise.reject(new Error("Plugin check-ins are unavailable"));
    }
    return this.runtime.subscriptionCheckin(pluginId, providerId, accountId);
  }

  subscriptionSignInPoll(
    pluginId: string,
    providerId: string,
    token: string,
  ): ReturnType<PluginRuntime["subscriptionSignInPoll"]> {
    if (this.runtime.subscriptionSignInPoll === undefined) {
      throw new Error("Plugin subscriptions are unavailable");
    }
    return this.runtime.subscriptionSignInPoll(pluginId, providerId, token);
  }

  /** Whether a running plugin hooks gateway traffic. */
  hasGatewayMiddlewares(): boolean {
    return this.runtime.hasGatewayMiddlewares?.() ?? false;
  }

  runGatewayMiddlewareRequest(
    input: Parameters<NonNullable<PluginRuntimePort["runGatewayMiddlewareRequest"]>>[0],
  ): ReturnType<NonNullable<PluginRuntimePort["runGatewayMiddlewareRequest"]>> | null {
    return this.runtime.runGatewayMiddlewareRequest?.(input) ?? null;
  }

  runGatewayMiddlewareResponse(
    input: Parameters<NonNullable<PluginRuntimePort["runGatewayMiddlewareResponse"]>>[0],
  ): ReturnType<NonNullable<PluginRuntimePort["runGatewayMiddlewareResponse"]>> | null {
    return this.runtime.runGatewayMiddlewareResponse?.(input) ?? null;
  }

  hasGatewayMiddlewareHook(hook: string): boolean {
    return this.runtime.hasGatewayMiddlewareHook?.(hook) ?? false;
  }

  /** Headers running plugins add to one outgoing gateway request. */
  runGatewayMiddlewareHeaders(
    input: Parameters<NonNullable<PluginRuntimePort["runGatewayMiddlewareHeaders"]>>[0],
  ): ReturnType<NonNullable<PluginRuntimePort["runGatewayMiddlewareHeaders"]>> {
    return this.runtime.runGatewayMiddlewareHeaders?.(input) ?? Promise.resolve(null);
  }

  runGatewayMiddlewareProvider(
    input: Parameters<NonNullable<PluginRuntimePort["runGatewayMiddlewareProvider"]>>[0],
  ): ReturnType<NonNullable<PluginRuntimePort["runGatewayMiddlewareProvider"]>> | null {
    return this.runtime.runGatewayMiddlewareProvider?.(input) ?? null;
  }

  runGatewayMiddlewareAccount(
    input: Parameters<NonNullable<PluginRuntimePort["runGatewayMiddlewareAccount"]>>[0],
  ): ReturnType<NonNullable<PluginRuntimePort["runGatewayMiddlewareAccount"]>> {
    return this.runtime.runGatewayMiddlewareAccount?.(input) ?? Promise.resolve(false);
  }

  runGatewayMiddlewareEvent(
    input: Parameters<NonNullable<PluginRuntimePort["runGatewayMiddlewareEvent"]>>[0],
  ): ReturnType<NonNullable<PluginRuntimePort["runGatewayMiddlewareEvent"]>> | null {
    return this.runtime.runGatewayMiddlewareEvent?.(input) ?? null;
  }

  /** Whether a running plugin observes gateway usage. */
  hasGatewayUsageObservers(): boolean {
    return this.runtime.hasGatewayUsageObservers?.() ?? false;
  }

  observeGatewayUsage(
    row: Parameters<NonNullable<PluginRuntimePort["observeGatewayUsage"]>>[0],
  ): void {
    this.runtime.observeGatewayUsage?.(row);
  }

  /** The routing strategies a running plugin contributes, by their own ids. */
  routingStrategiesOf(pluginId: string): readonly string[] {
    return this.runtime.routingStrategiesOf?.(pluginId) ?? [];
  }

  runRoutingStrategy(
    name: string,
    input: Parameters<NonNullable<PluginRuntimePort["runRoutingStrategy"]>>[1],
  ): ReturnType<NonNullable<PluginRuntimePort["runRoutingStrategy"]>> {
    return this.runtime.runRoutingStrategy?.(name, input) ?? Promise.resolve(null);
  }

  /** Every running plugin's agent wiring. */
  listAgentIntegrations(): ReturnType<NonNullable<PluginRuntimePort["listAgentIntegrations"]>> {
    return this.runtime.listAgentIntegrations?.() ?? [];
  }

  wireAgentIntegration(
    pluginId: string,
    integrationId: string,
    input: Parameters<NonNullable<PluginRuntimePort["wireAgentIntegration"]>>[2],
  ): ReturnType<NonNullable<PluginRuntimePort["wireAgentIntegration"]>> {
    return (
      this.runtime.wireAgentIntegration?.(pluginId, integrationId, input) ?? Promise.resolve(null)
    );
  }

  /** The search APIs plugins give the gateway, as search.apis vendors name them. */
  listSearchApis(): Array<{
    vendor: string;
    name: string;
    keysURL?: string;
    keyOptional?: boolean;
    needURL?: boolean;
  }> {
    const apis: Array<{
      vendor: string;
      name: string;
      keysURL?: string;
      keyOptional?: boolean;
      needURL?: boolean;
    }> = [];
    for (const search of this.runtime.allSearchApis()) {
      const api: (typeof apis)[number] = {
        vendor: pluginSearchVendor(search.pluginId, search.id),
        name: search.name,
      };
      if (search.keysURL !== undefined) api.keysURL = search.keysURL;
      if (search.keyOptional !== undefined) api.keyOptional = search.keyOptional;
      if (search.needURL !== undefined) api.needURL = search.needURL;
      apis.push(api);
    }
    return apis;
  }

  /** Asks a plugin's search API, its vendor id naming the plugin and API. */
  executeSearchApi(
    vendor: string,
    input: { query: string; key: string | null; url: string | null },
  ): Promise<unknown> {
    const parsed = parsePluginSearchVendor(vendor);
    if (parsed === null) {
      return Promise.reject(new Error(`Unknown plugin search API: ${vendor}`));
    }
    return this.runtime.executeSearch(parsed.pluginId, parsed.searchId, input);
  }

  listUsageReports(options?: ListUsageReportsOptions) {
    return this.usageSources.listReports(options);
  }

  listLegacyUsage() {
    return this.usageSources.listLegacyUsage();
  }

  subscribeProviderRegistrations(listener: () => void): () => void {
    this.providerListeners.add(listener);
    return () => this.providerListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const config = this.configStore.get();
    this.globalStartsBlocked = config.pluginsEnabled !== true;
    await this.builtinPlugins.load(async (plugin) => {
      try {
        await this.runtime.startBuiltinPlugin?.(plugin);
        await this.publishProviderRegistrations(plugin.id, plugin.directory);
        this.publishUsageSources(plugin.id);
      } catch (error) {
        this.logger.error({ err: error, pluginId: plugin.id }, "Failed to start built-in plugin");
      }
    });
    if (config.pluginsEnabled === true) {
      let earlierPublished: Promise<unknown> = Promise.resolve();
      await Promise.all(
        Object.entries(config.plugins ?? {})
          .filter(([, source]) => source.enabled !== false)
          .map(async ([pluginId]) => {
            const publishTurn = earlierPublished;
            const starting = this.startConfigured(pluginId, publishTurn);
            earlierPublished = Promise.all([publishTurn, starting]);
            await starting;
            this.notify(pluginId);
          }),
      );
    }
    this.configStore.onFieldChange("pluginsEnabled", (value) => {
      this.handleGlobalSwitch(value === true);
    });
  }

  /** Built-in plugin IDs in the order the loader starts them; they are not in `listPlugins`. */
  listBuiltinPluginIds(): string[] {
    return [...this.builtinPluginIds];
  }

  /** The published plugin registry's listings, with npm's download counts where npm answers. */
  getPluginMarket() {
    return loadPluginMarket(this.dependencies.market);
  }

  searchPluginMarket(query: string, options: { mirror?: boolean }) {
    return searchNpmPlugins(query, options);
  }

  /** A plugin's README, read from its registry entry, npm package, or GitHub repository. */
  getPluginReadme(source: PluginReadmeSource, locale?: string) {
    return loadPluginReadme(
      source,
      {
        baseUrl: this.dependencies.market?.baseUrl,
        registries: this.dependencies.market?.registries,
      },
      locale,
    );
  }

  async listPlugins(): Promise<PluginListItem[]> {
    const config = this.configStore.get();
    const running = new Set(this.runtime.catalog().map((plugin) => plugin.id));
    const plugins = await Promise.all(
      Object.entries(config.plugins ?? {}).map(async ([id, source]) => {
        const enabled = source.enabled !== false;
        const item: PluginListItem = {
          id,
          path: source.path,
          enabled,
          status: resolvePluginStatus({
            enabled,
            globallyEnabled: config.pluginsEnabled === true,
            running: running.has(id),
          }),
        };
        const manifest = await readPluginManifest(path.resolve(source.path)).catch(() => null);
        if (manifest) {
          item.name = manifest.name;
          item.description = manifest.description;
          item.icon = manifest.icon;
          item.media = manifest.media;
          if (manifest.contributions) item.contributions = manifest.contributions;
          if (manifest.web) item.web = manifest.web;
        }
        item.providers = [...(this.providerIdsByPlugin.get(id) ?? [])];
        const settings = this.runtime.getSettingsRegistrations?.(id) ?? [];
        if (settings.length > 0) item.settings = [...settings];
        const strategies = this.routingStrategiesOf(id);
        if (strategies.length > 0) {
          item.strategies = strategies.map((strategy) => `${id}/${strategy}`);
        }
        item.installation = await this.managedSources
          ?.describe(id, source.path)
          .catch(() => undefined);
        if (!this.managedSources)
          item.installation = { identity: { kind: "directory", path: path.resolve(source.path) } };
        if (item.installation?.identity.kind === "git") {
          item.source = "git";
          item.remote = item.installation.identity.remote;
          item.commit = item.installation.currentRevision;
        }
        const error = this.errors.get(id);
        if (error && item.status === "failed") item.error = error;
        return item;
      }),
    );
    return plugins.sort((left, right) => left.id.localeCompare(right.id));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    if (!this.builtinPluginIds.has(pluginId)) {
      this.requireSource(pluginId);
    }
    return this.runtime.getLogs(pluginId);
  }

  /**
   * Reads one declared web asset for a sandboxed view. Paths come from the request schema, which
   * already rejects traversal and absolute paths; the resolved path is checked again against the
   * configured plugin directory so a symlinked checkout cannot escape it.
   */
  async getWebAsset(
    pluginId: string,
    assetPath: string,
  ): Promise<{
    pluginId: string;
    path: string;
    contentType: PluginWebAssetContentType;
    encoding: "utf8" | "base64";
    content: string;
  }> {
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source) throw new Error(`Plugin "${pluginId}" is not installed`);
    if (source.enabled === false) throw new Error(`Plugin "${pluginId}" is disabled`);
    return { pluginId, ...(await readPluginWebAssetFile(path.resolve(source.path), assetPath)) };
  }

  catalog(): ReturnType<PluginRuntime["catalog"]> {
    return this.runtime.catalog();
  }

  async installDirectory(input: { path: string; id?: string }): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const directory = path.resolve(input.path);
      await assertDirectoryMynaSupport(directory);
      const manifest = await readPluginManifest(directory);
      assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
      const pluginId = PluginIdSchema.parse(input.id ?? manifest.id);
      if (this.builtinPluginIds.has(pluginId)) {
        throw new Error(`Plugin ID "${pluginId}" is reserved for a built-in plugin`);
      }
      if (this.configStore.get().plugins?.[pluginId]) {
        throw new Error(
          `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
        );
      }
      await this.patchSource(pluginId, { source: "directory", path: directory, enabled: true });
      if (this.canPublish(pluginId)) await this.startConfigured(pluginId);
      this.notify(pluginId);
      const installed = await this.requireItem(pluginId);
      if (installed.status === "failed") {
        throw new Error(installed.error ?? `Plugin failed to start: ${pluginId}`);
      }
      return installed;
    });
  }

  async inspectDirectory(configuredPath: string): Promise<{ id: string }> {
    const directory = path.resolve(configuredPath);
    await assertDirectoryMynaSupport(directory);
    return readPluginManifest(directory);
  }

  async installSource(input: {
    source: string;
    id?: string;
    ref?: string;
  }): Promise<PluginListItem> {
    if (input.id && this.builtinPluginIds.has(input.id)) {
      throw new Error(`Plugin ID "${input.id}" is reserved for a built-in plugin`);
    }
    const reference = parsePluginSourceReference(input.source);
    if (reference.kind === "directory") {
      const directory = path.resolve(expandTilde(reference.source));
      const info = await stat(directory).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`Plugin directory does not exist: ${directory}`);
      if (input.ref) throw new Error("Plugin --ref is only valid for Git sources");
      const pluginDirectory = resolveLocalPluginPath(directory, reference.pluginPath);
      return this.installDirectory({ path: pluginDirectory, id: input.id });
    }
    const managedSources = this.requireManagedSources();
    return this.enqueue(async () => {
      let candidate = await managedSources.prepareInstall({
        ...input,
        source: reference.source,
        pluginPath: reference.pluginPath,
      });
      let pluginId: string;
      try {
        await this.checkRequirements(candidate.directory);
        pluginId = PluginIdSchema.parse(input.id ?? candidate.defaultId);
        if (this.builtinPluginIds.has(pluginId)) {
          throw new Error(`Plugin ID "${pluginId}" is reserved for a built-in plugin`);
        }
        if (this.configStore.get().plugins?.[pluginId]) {
          throw new Error(
            `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
          );
        }
        await runPluginBuild(candidate.directory, candidate.build, this.logger);
        candidate = await managedSources.place(pluginId, candidate);
        await this.validateCandidate(candidate);
        await managedSources.verifyCandidate(pluginId, candidate);
      } catch (error) {
        await managedSources.discard(candidate);
        throw error;
      }
      await this.patchSource(pluginId, {
        source: "directory",
        path: candidate.directory,
        enabled: true,
      });
      try {
        if (this.canPublish(pluginId)) await this.startExplicit(pluginId, candidate.directory);
        managedSources.commit(pluginId, candidate.record);
      } catch (error) {
        await this.stopPlugin(pluginId);
        await this.removeSource(pluginId);
        await managedSources.discard(candidate);
        this.errors.delete(pluginId);
        this.notify(pluginId);
        throw error;
      }
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async statusSources(pluginId?: string): Promise<PluginSourceStatusItem[]> {
    return this.enqueue(async () => {
      const sources = this.configStore.get().plugins ?? {};
      const selected = pluginId
        ? [[pluginId, this.requireSource(pluginId)] as const]
        : Object.entries(sources);
      const managedSources = this.requireManagedSources();
      const statuses: PluginSourceStatusItem[] = [];
      for (const [id, source] of selected) {
        statuses.push(await managedSources.status(id, source.path));
      }
      return statuses.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  // COMPAT(plugin-immediate-update): added in v0.8.0; remove after 2027-03-16 when clients use reviewed targets.
  async updateSources(_pluginId?: string): Promise<PluginSourceUpdateItem[]> {
    throw new Error("Update the client to review plugin updates before applying them.");
  }

  async previewUpdates(input: {
    pluginId?: string;
    target?: PluginUpdateSelection;
  }): Promise<PluginUpdatePreview[]> {
    if (input.target && !input.pluginId)
      throw new Error("An explicit update target requires one plugin ID");
    const sources = this.configStore.get().plugins ?? {};
    const ids = input.pluginId ? [input.pluginId] : Object.keys(sources).sort();
    return Promise.all(
      ids.map(async (id) => {
        try {
          return await this.requireManagedSources().preview(
            id,
            this.requireSource(id).path,
            input.target,
          );
        } catch (error) {
          return {
            id,
            outcome: "error" as const,
            links: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  async applyUpdates(proposals: PluginUpdateProposal[]): Promise<PluginUpdateResult[]> {
    return this.enqueue(async () => {
      const results: PluginUpdateResult[] = [];
      for (const proposal of proposals) {
        try {
          results.push(await this.updateSource(proposal));
        } catch (error) {
          results.push({
            id: proposal.id,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
  }

  async reloadPlugin(pluginId: string): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const source = this.requireEnabledSource(pluginId);
      if (this.configStore.get().pluginsEnabled !== true) {
        throw new Error("Plugins are globally disabled");
      }
      this.errors.delete(pluginId);
      await this.stopPlugin(pluginId);
      await this.startExplicit(pluginId, source.path);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async enablePlugin(pluginId: string): Promise<PluginListItem> {
    await this.patchSource(pluginId, (source) => ({ ...source, enabled: true }));
    this.errors.delete(pluginId);
    return this.enqueue(async () => {
      // Cancellation persistence uses the store queue, so it never waits behind a blocked start.
      await this.pendingOperations.get(pluginId)?.completion.catch(() => {});
      const current = this.requireSource(pluginId);
      if (current.enabled !== false && this.configStore.get().pluginsEnabled === true) {
        await this.startExplicit(pluginId, current.path);
      }
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async disablePlugin(pluginId: string): Promise<PluginListItem> {
    const operation = {
      kind: "disable",
      completion: this.patchSource(pluginId, (source) => ({ ...source, enabled: false })),
    } as const;
    this.pendingOperations.set(pluginId, operation);
    try {
      await operation.completion;
    } finally {
      if (this.pendingOperations.get(pluginId) === operation)
        this.pendingOperations.delete(pluginId);
    }
    const stopping = this.stopPlugin(pluginId);
    return this.enqueue(async () => {
      await stopping;
      this.errors.delete(pluginId);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async removePlugin(pluginId: string): Promise<void> {
    this.requireSource(pluginId);
    const operation = { kind: "remove", completion: this.removeSource(pluginId) } as const;
    this.pendingOperations.set(pluginId, operation);
    try {
      await operation.completion;
    } finally {
      if (this.pendingOperations.get(pluginId) === operation)
        this.pendingOperations.delete(pluginId);
    }
    const stopping = this.stopPlugin(pluginId);
    await this.enqueue(async () => {
      await stopping;
      this.runtime.clearLogs(pluginId);
      this.errors.delete(pluginId);
      this.notify(pluginId);
      await this.managedSources?.remove(pluginId);
      if (this.dependencies.settingsDirectory)
        await rm(path.join(this.dependencies.settingsDirectory, pluginId), {
          recursive: true,
          force: true,
        });
    });
  }

  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown> {
    return this.runtime.invoke(pluginId, method, input);
  }

  subscribePluginRpc(pluginId: string, method: string, input: unknown): PluginRuntimeSubscription {
    return this.runtime.startSubscription(pluginId, method, input);
  }

  async stopAllPlugins(): Promise<void> {
    this.globalStartsBlocked = true;
    const stopping = this.stopAll();
    await this.enqueue(async () => {
      await stopping;
      await this.stopAll();
    });
  }

  private handleGlobalSwitch(enabled: boolean): void {
    if (!enabled) {
      this.globalStartsBlocked = true;
      const stopping = this.stopConfiguredPlugins();
      for (const id of Object.keys(this.configStore.get().plugins ?? {})) this.notify(id);
      void this.enqueue(async () => {
        await stopping;
      }).catch((error) => this.logger.error({ err: error }, "Failed to disable plugins"));
      return;
    }
    void this.enqueue(async () => {
      this.globalStartsBlocked = false;
      for (const [pluginId, source] of Object.entries(this.configStore.get().plugins ?? {})) {
        if (source.enabled !== false) await this.startConfigured(pluginId);
        this.notify(pluginId);
      }
    }).catch((error) => this.logger.error({ err: error }, "Failed to enable plugins"));
  }

  private async startConfigured(pluginId: string, publishTurn?: Promise<unknown>): Promise<void> {
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source || source.enabled === false || !this.canPublish(pluginId)) return;
    this.errors.delete(pluginId);
    try {
      await this.startPlugin(pluginId, source.path, publishTurn);
    } catch (error) {
      if (this.canPublish(pluginId)) this.recordFailure(pluginId, error);
    }
  }

  private async startExplicit(pluginId: string, sourcePath: string): Promise<void> {
    try {
      await this.startPlugin(pluginId, sourcePath);
    } catch (error) {
      if (this.canPublish(pluginId)) {
        this.recordFailure(pluginId, error);
        this.notify(pluginId);
      }
      throw error;
    }
  }

  private canPublish(pluginId: string): boolean {
    const config = this.configStore.get();
    return (
      !this.pendingOperations.has(pluginId) &&
      !this.globalStartsBlocked &&
      config.pluginsEnabled === true &&
      config.plugins?.[pluginId]?.enabled !== false &&
      config.plugins?.[pluginId] !== undefined
    );
  }

  private async startPlugin(
    pluginId: string,
    sourcePath: string,
    publishTurn?: Promise<unknown>,
  ): Promise<void> {
    await this.runtime.startPlugin(pluginId, sourcePath, () => this.canPublish(pluginId));
    await publishTurn;
    try {
      await this.publishProviderRegistrations(pluginId, sourcePath);
      this.publishUsageSources(pluginId);
    } catch (error) {
      try {
        this.removeProviderRegistrations(pluginId);
        this.removeUsageSources(pluginId);
      } finally {
        await this.runtime.stopPluginById(pluginId);
      }
      throw error;
    }
  }

  private stopPlugin(pluginId: string): Promise<boolean> {
    this.removeProviderRegistrations(pluginId);
    this.removeUsageSources(pluginId);
    return this.runtime.stopPluginById(pluginId);
  }

  private async stopConfiguredPlugins(): Promise<void> {
    const stopping = Object.keys(this.configStore.get().plugins ?? {}).map((id) =>
      this.stopPlugin(id),
    );
    await Promise.all(stopping);
  }

  private async stopAll(): Promise<void> {
    for (const pluginId of this.providerIdsByPlugin.keys()) {
      this.removeProviderRegistrations(pluginId);
    }
    for (const pluginId of this.usageSourceIdsByPlugin.keys()) this.removeUsageSources(pluginId);
    await this.runtime.stopAll();
  }

  private publishUsageSources(pluginId: string): void {
    const metadata = this.runtime.getUsageSourceRegistrations(pluginId);
    const registered: string[] = [];
    try {
      for (const source of metadata) {
        this.usageSources.register({
          id: source.id,
          label: source.label,
          icon: source.icon,
          discover: async (scope) => {
            const result = await this.runtime.discoverUsage(pluginId, source.id, scope);
            if (!Array.isArray(result))
              throw new Error(`Invalid usage discovery from ${source.id}`);
            return result;
          },
          fetch: (input) => {
            return this.runtime.fetchUsage(pluginId, source.id, input);
          },
        });
        registered.push(source.id);
      }
    } catch (error) {
      for (const id of registered) this.usageSources.unregister(id);
      throw error;
    }
    this.usageSourceIdsByPlugin.set(pluginId, registered);
  }

  private removeUsageSources(pluginId: string): void {
    for (const id of this.usageSourceIdsByPlugin.get(pluginId) ?? [])
      this.usageSources.unregister(id);
    this.usageSourceIdsByPlugin.delete(pluginId);
  }

  private async publishProviderRegistrations(
    pluginId: string,
    pluginDirectory: string,
  ): Promise<void> {
    const metadata = this.runtime.getProviderRegistrations?.(pluginId) ?? [];
    for (const provider of metadata) {
      if (BUILTIN_PROVIDER_ID_SET.has(provider.id)) {
        throw new Error(`Plugin ${pluginId} cannot register builtin provider ID "${provider.id}"`);
      }
      if (this.providers.has(provider.id)) {
        throw new Error(`Plugin ${pluginId} cannot register provider ID "${provider.id}" twice`);
      }
    }
    const registrations = await Promise.all(
      metadata.map(
        async (provider): Promise<ProviderRegistration> => ({
          id: provider.id,
          label: provider.label,
          description: provider.description,
          command: provider.command,
          requiresConfiguration: provider.requiresConfiguration,
          supportsAccountDerivation: provider.supportsAccountDerivation,
          status: provider.hasStatus
            ? (request) => {
                if (!this.runtime.getProviderStatus)
                  throw new Error("Plugin runtime cannot resolve provider status");
                return this.runtime.getProviderStatus(pluginId, provider.id, request);
              }
            : undefined,
          getCatalogCacheKey: provider.hasCatalogCacheKey
            ? (options) => {
                if (!this.runtime.getProviderCatalogCacheKey)
                  throw new Error("Plugin runtime cannot resolve catalogue keys");
                return this.runtime.getProviderCatalogCacheKey(pluginId, provider.id, options);
              }
            : undefined,
          icon: provider.iconPath
            ? await readPluginProviderIcon(pluginDirectory, provider.iconPath)
            : undefined,
          connect: (request) => this.runtime.connectProvider(pluginId, provider.id, request),
        }),
      ),
    );
    const ids = registrations.map((provider) => provider.id);
    for (const provider of registrations) {
      this.providers.set(provider.id, {
        ...provider,
      });
    }
    if (ids.length > 0) {
      this.providerIdsByPlugin.set(pluginId, ids);
      this.notifyProviderRegistrations();
    }
  }

  private removeProviderRegistrations(pluginId: string): void {
    const ids = this.providerIdsByPlugin.get(pluginId);
    if (!ids) return;
    this.providerIdsByPlugin.delete(pluginId);
    for (const id of ids) this.providers.delete(id);
    this.notifyProviderRegistrations();
  }

  private notifyProviderRegistrations(): void {
    for (const listener of this.providerListeners) listener();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private recordFailure(pluginId: string, error: unknown): void {
    this.errors.set(pluginId, error instanceof Error ? error.message : String(error));
  }

  private async checkRequirements(directory: string): Promise<void> {
    const manifest = await readPluginManifest(directory);
    assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
  }

  private async updateSource(proposal: PluginUpdateProposal): Promise<PluginUpdateResult> {
    const pluginId = proposal.id;
    const managedSources = this.requireManagedSources();
    const source = this.requireSource(pluginId);
    let candidate = await managedSources.prepareUpdate(proposal, source.path);
    try {
      await this.checkRequirements(candidate.directory);
      await runPluginBuild(candidate.directory, candidate.build, this.logger);
      candidate = await managedSources.place(pluginId, candidate);
      await this.validateCandidate(candidate);
      await managedSources.verifyCandidate(pluginId, candidate, proposal.target);
      await managedSources.assertCurrent(proposal, this.requireSource(pluginId).path);
    } catch (error) {
      await managedSources.discard(candidate);
      throw error;
    }

    const current = this.requireSource(pluginId);
    const isRunning = this.runtime.catalog().some((plugin) => plugin.id === pluginId);
    const shouldActivate =
      current.enabled !== false && this.configStore.get().pluginsEnabled === true;
    if (shouldActivate) {
      if (isRunning) await this.stopPlugin(pluginId);
      try {
        await this.startExplicit(pluginId, candidate.directory);
      } catch (error) {
        let recoveryError: unknown;
        try {
          this.errors.delete(pluginId);
          if (isRunning && this.canPublish(pluginId))
            await this.startExplicit(pluginId, source.path);
        } catch (restoreError) {
          recoveryError = restoreError;
        } finally {
          await managedSources.discard(candidate);
          this.notify(pluginId);
        }
        if (recoveryError)
          throw new Error(
            `Update failed: ${error instanceof Error ? error.message : String(error)}; restoring previous plugin also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
            { cause: error },
          );
        throw error;
      }
    }
    const activatedSource = this.configStore.get().plugins?.[pluginId];
    if (!activatedSource) {
      await this.stopPlugin(pluginId);
      await managedSources.discard(candidate);
      throw new Error(`Plugin is no longer configured: ${pluginId}`);
    }
    await this.patchSource(pluginId, (currentSource) => ({
      ...currentSource,
      path: candidate.directory,
    }));
    this.errors.delete(pluginId);
    this.notify(pluginId);
    let warning: string | undefined;
    try {
      await managedSources.removeVersion(pluginId, source.path);
    } catch (error) {
      warning = `Plugin updated, but previous installation cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      id: pluginId,
      outcome: "updated",
      plugin: await this.requireItem(pluginId),
      ...(warning ? { warning } : {}),
    };
  }

  private validateCandidate(candidate: ManagedPluginCandidate): Promise<void> {
    if (!this.runtime.validatePlugin) {
      throw new Error("Plugin runtime cannot validate managed sources");
    }
    return this.runtime.validatePlugin(candidate.directory);
  }

  private requireManagedSources(): ManagedPluginSources {
    if (!this.managedSources) throw new Error("Plugin source management is unavailable");
    return this.managedSources;
  }

  private requireSource(pluginId: string): PluginSource {
    PluginIdSchema.parse(pluginId);
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source) throw new Error(`Plugin is not configured: ${pluginId}`);
    return source;
  }

  private requireEnabledSource(pluginId: string): PluginSource {
    const source = this.requireSource(pluginId);
    if (source.enabled === false) throw new Error(`Plugin is disabled: ${pluginId}`);
    return source;
  }

  private async patchSource(
    pluginId: string,
    update: PluginSource | ((source: PluginSource) => PluginSource),
  ): Promise<void> {
    await this.configStore.patch((current) => {
      const source = current.plugins?.[pluginId];
      if (typeof update === "function" && !source)
        throw new Error(`Plugin is not configured: ${pluginId}`);
      return {
        plugins: {
          ...current.plugins,
          [pluginId]: typeof update === "function" ? update(source!) : update,
        },
      };
    });
  }

  private async removeSource(pluginId: string): Promise<void> {
    await this.configStore.patch((current) => {
      const sources = { ...current.plugins };
      delete sources[pluginId];
      return { plugins: sources };
    });
  }

  private async requireItem(pluginId: string): Promise<PluginListItem> {
    const item = (await this.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (!item) throw new Error(`Plugin is not configured: ${pluginId}`);
    return item;
  }

  private notify(pluginId: string): void {
    for (const listener of this.listeners) listener(pluginId);
  }
}

function resolveLocalPluginPath(directory: string, pluginPath: string | undefined): string {
  if (!pluginPath) return directory;
  if (path.isAbsolute(pluginPath)) throw new Error("Plugin path must be relative to the source");
  const pluginDirectory = path.resolve(directory, pluginPath);
  const relative = path.relative(directory, pluginDirectory);
  const escapesSource =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesSource) throw new Error("Plugin path must stay inside the source directory");
  return pluginDirectory;
}

/** The vendor id a plugin's search API is named by, in search.apis. */
export function pluginSearchVendor(pluginId: string, searchId: string): string {
  return `plugin:${pluginId}:${searchId}`;
}

export function parsePluginSearchVendor(
  vendor: string,
): { pluginId: string; searchId: string } | null {
  const parts = vendor.split(":");
  if (parts.length !== 3 || parts[0] !== "plugin" || !parts[1] || !parts[2]) {
    return null;
  }
  return { pluginId: parts[1], searchId: parts[2] };
}
